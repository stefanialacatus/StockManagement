from flask import Flask, request, jsonify
from flask_cors import CORS
from flask_jwt_extended import JWTManager, create_access_token, jwt_required
from datetime import timedelta, date
import psycopg2
from psycopg2 import sql
from psycopg2.extras import RealDictCursor
import os
from dotenv import load_dotenv
from ortools.linear_solver import pywraplp
import math

load_dotenv()

app = Flask(__name__)
CORS(app)

app.config['JWT_SECRET_KEY'] = os.getenv('JWT_SECRET_KEY', 'your-secret-key-change-in-production')
app.config['JWT_ACCESS_TOKEN_EXPIRES'] = timedelta(hours=24)
jwt = JWTManager(app)

@jwt.expired_token_loader
def expired_token_callback(jwt_header, jwt_payload):
    print("JWT Token expired")
    return jsonify({'error': 'Token has expired'}), 401

@jwt.invalid_token_loader
def invalid_token_callback(error):
    print(f"JWT Invalid token: {error}")
    return jsonify({'error': 'Invalid token'}), 401

@jwt.unauthorized_loader
def missing_token_callback(error):
    print(f"JWT Missing token: {error}")
    return jsonify({'error': 'Missing authorization token'}), 401

def get_db_connection():
    conn = psycopg2.connect(
        host=os.getenv('DB_HOST', 'localhost'),
        port=os.getenv('DB_PORT', '5432'),
        database=os.getenv('DB_NAME', 'stock_management'),
        user=os.getenv('DB_USER', 'postgres'),
        password=os.getenv('DB_PASSWORD', '')
    )
    return conn


def sync_serial_sequence(cur, table_name, id_column):
    cur.execute("SELECT pg_get_serial_sequence(%s, %s)", (table_name, id_column))
    seq_row = cur.fetchone()
    if not seq_row:
        return

    if isinstance(seq_row, dict):
        sequence_name = seq_row.get('pg_get_serial_sequence')
    else:
        sequence_name = seq_row[0]

    if not sequence_name:
        return

    cur.execute(
        sql.SQL("SELECT COALESCE(MAX({}), 0) FROM {}")
        .format(sql.Identifier(id_column), sql.Identifier(table_name))
    )
    max_row = cur.fetchone()
    if isinstance(max_row, dict):
        max_id = list(max_row.values())[0] or 0
    else:
        max_id = max_row[0] or 0

    cur.execute("SELECT setval(%s, %s, false)", (sequence_name, max_id + 1))

DISTANCES_KM = {
    (1, 2): 400,
    (1, 3): 150,
    (1, 4): 300,
    (1, 5): 500,
    (2, 1): 400,
    (2, 3): 350,
    (2, 4): 160,
    (2, 5): 550,
    (3, 1): 150,
    (3, 2): 350,
    (3, 4): 180,
    (3, 5): 420,
    (4, 1): 300,
    (4, 2): 160,
    (4, 3): 180,
    (4, 5): 380,
    (5, 1): 500,
    (5, 2): 550,
    (5, 3): 420,
    (5, 4): 380
}

COST_PER_10KM = 1
VEHICLE_CAPACITY = 50


def calculate_trip_cost(from_store_id, to_store_id):
    try:
        from_id = int(from_store_id)
        to_id = int(to_store_id)
    except (TypeError, ValueError):
        return 0

    distance = DISTANCES_KM.get((from_id, to_id), 500)
    return COST_PER_10KM * math.ceil(distance / 10)


def calculate_cost(from_store_id, to_store_id, quantity):
    try:
        qty = int(quantity)
    except (TypeError, ValueError):
        return 0

    if qty <= 0:
        return 0

    trips = math.ceil(qty / VEHICLE_CAPACITY)
    trip_cost = calculate_trip_cost(from_store_id, to_store_id)
    return round(trips * trip_cost, 2)

def calculate_velocity(store_id, product_id):
    conn = get_db_connection()
    cur = conn.cursor()
    
    cur.execute("""
        SELECT COALESCE(SUM(quantity), 0) as total
        FROM sales
        WHERE store_id = %s AND product_id = %s 
        AND sale_date >= CURRENT_DATE - INTERVAL '7 days'
    """, (store_id, product_id))
    sales_7d = cur.fetchone()[0]
    cur.execute("""
        SELECT COALESCE(SUM(quantity), 0) as total
        FROM sales
        WHERE store_id = %s AND product_id = %s 
        AND sale_date >= CURRENT_DATE - INTERVAL '14 days'
    """, (store_id, product_id))
    sales_14d = cur.fetchone()[0]
    
    cur.execute("""
        SELECT COALESCE(SUM(quantity), 0) as total
        FROM sales
        WHERE store_id = %s AND product_id = %s 
        AND sale_date >= CURRENT_DATE - INTERVAL '30 days'
    """, (store_id, product_id))
    sales_30d = cur.fetchone()[0]
    
    cur.close()
    conn.close()
    
    velocity = (sales_7d * 0.5) + (sales_14d * 0.3) + (sales_30d * 0.2)
    return velocity

def calculate_sell_through(store_id, product_id, initial_stock):
    if initial_stock == 0:
        return 0
    
    conn = get_db_connection()
    cur = conn.cursor()
    
    cur.execute("""
        SELECT COALESCE(SUM(quantity), 0) as total
        FROM sales
        WHERE store_id = %s AND product_id = %s
    """, (store_id, product_id))
    total_sold = cur.fetchone()[0]
    
    cur.close()
    conn.close()
    
    sell_through = (total_sold * 100) / initial_stock
    return sell_through

def calculate_stock_age(store_id, product_id, stock, stored_stock_age):
    conn = get_db_connection()
    cur = conn.cursor()
    
    cur.execute("""
        SELECT quantity, transfer_date
        FROM transfers
        WHERE to_store_id = %s AND product_id = %s
        ORDER BY transfer_date DESC
        LIMIT 1
    """, (store_id, product_id))
    last_transfer = cur.fetchone()
    
    cur.close()
    conn.close()
    
    if last_transfer:
        transfer_qty, transfer_date = last_transfer
        if stock <= transfer_qty:
            age = (date.today() - transfer_date).days
            return age
    
    return stored_stock_age or 0

def get_status_alert(stock_days, stock_age, sell_through):
    if stock_age >= 100 and sell_through <= 20:
        print(f"!!! Stock age: {stock_age}, Sell-through: {sell_through} - Marking as DEAD STOCK")
        return 'DEAD STOCK'
    
    if stock_days <= 7:
        return 'UNDERSTOCK'
    elif stock_days > 7 and stock_days <= 14:
        return 'AT-RISK'
    elif stock_days > 14 and stock_days <= 50:
        return 'OK'
    elif stock_days > 50 and stock_days <= 100:
        return 'OVERSTOCK'
    else:
        return 'OVERSTOCK'

@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.get_json()
    username = data.get('username')
    password = data.get('password')
    
    if not username or not password:
        return jsonify({'error': 'Username and password required'}), 400
    
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    
    cur.execute('SELECT * FROM users WHERE username = %s', (username,))
    user = cur.fetchone()
    
    cur.close()
    conn.close()
    
    if not user:
        return jsonify({'error': 'Invalid credentials'}), 401
    
    if user['password'] != password:
        return jsonify({'error': 'Invalid credentials'}), 401
    
    token = create_access_token(identity=str(user['user_id']))
    
    return jsonify({
        'token': token,
        'userId': user['user_id'],
        'username': user['username'],
        'role': 'admin' if user['admin'] else 'manager',
        'storeId': user.get('store_id')
    }), 200

@app.route('/api/stores', methods=['GET'])
@jwt_required()
def get_stores():
    print("=" * 50)
    print("get_stores function called!")
    print("=" * 50)
    import sys
    sys.stdout.flush()
    try:
        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute('SELECT * FROM stores ORDER BY store_id')
        stores = cur.fetchall()
    
        result = []
        for store in stores:
            store_data = {
                'id': store['store_id'],
                'name': store['name'],
                'location': store['location'],
                'products': []
            }
            
            cur.execute("""
                SELECT p.product_id, p.name, p.cost, 
                       i.stock, i.initial_stock, i.stock_age
                FROM products p
                LEFT JOIN inventory i ON p.product_id = i.product_id AND i.store_id = %s
            """, (store['store_id'],))
            products = cur.fetchall()
            
            for product in products:
                product_id = product['product_id']
                stock = product['stock'] or 0
                initial_stock_qty = product['initial_stock'] or 0  
                stored_stock_age = product['stock_age'] or 0  
                
                velocity = calculate_velocity(store['store_id'], product_id)
                stock_days = stock / velocity if velocity > 0 else float('inf')
                if initial_stock_qty == 0:
                    cur.execute("""
                        SELECT COALESCE(SUM(quantity), 0) as total_in
                        FROM transfers
                        WHERE to_store_id = %s AND product_id = %s
                    """, (store['store_id'], product_id))
                    total_transferred_in = cur.fetchone()['total_in']
                    
                    cur.execute("""
                        SELECT COALESCE(SUM(quantity), 0) as total_out
                        FROM transfers
                        WHERE from_store_id = %s AND product_id = %s
                    """, (store['store_id'], product_id))
                    total_transferred_out = cur.fetchone()['total_out']
                    
                    cur.execute("""
                        SELECT COALESCE(SUM(quantity), 0) as total_sold
                        FROM sales
                        WHERE store_id = %s AND product_id = %s
                    """, (store['store_id'], product_id))
                    total_sold = cur.fetchone()['total_sold']
                    
                    initial_stock_qty = stock + total_sold + total_transferred_out - total_transferred_in
                    if initial_stock_qty < stock:
                        initial_stock_qty = stock + total_sold
                    if initial_stock_qty == 0:
                        initial_stock_qty = 100 
                
                sell_through = calculate_sell_through(store['store_id'], product_id, initial_stock_qty)
                stock_age_days = calculate_stock_age(store['store_id'], product_id, stock, stored_stock_age)
                status = get_status_alert(stock_days, stock_age_days, sell_through)
                days_in_stock = int(stock_days) if stock_days != float('inf') else 999
                
                product_data = {
                    'id': product_id,
                    'name': product['name'],
                    'stock': stock,
                    'velocity': round(velocity, 2),
                    'daysInStock': days_in_stock,
                    'cost': product['cost'],
                    'status': status,
                    'stockAge': stock_age_days,
                    'sellThrough': round(sell_through, 2)
                }
                
                store_data['products'].append(product_data)
            
            result.append(store_data)
    
        cur.close()
        conn.close()
        
        return jsonify(result), 200
    except Exception as e:
        print(f"Error in get_stores: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/api/sales', methods=['POST'])
@jwt_required()
def record_sale():
    data = request.get_json()
    store_id = data.get('storeId')
    product_id = data.get('productId')
    quantity = data.get('quantity')
    
    if not all([store_id, product_id, quantity]):
        return jsonify({'error': 'Missing required fields'}), 400

    try:
        store_id = int(store_id)
        product_id = int(product_id)
        quantity = int(quantity)
    except (TypeError, ValueError):
        return jsonify({'error': 'Invalid sale payload. IDs and quantity must be integers.'}), 400

    if quantity <= 0:
        return jsonify({'error': 'Quantity must be greater than 0'}), 400
    
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    
    try:
        sync_serial_sequence(cur, 'sales', 'sale_id')
        cur.execute("""
            SELECT stock FROM inventory 
            WHERE store_id = %s AND product_id = %s
        """, (store_id, product_id))
        inventory = cur.fetchone()
        
        if not inventory or inventory['stock'] < quantity:
            available = inventory['stock'] if inventory else 0
            cur.close()
            conn.close()
            return jsonify({'error': f'Insufficient stock. Available: {available}, requested: {quantity}'}), 400
        
        cur.execute("""
            INSERT INTO sales (store_id, product_id, quantity, sale_date)
            VALUES (%s, %s, %s, CURRENT_DATE)
            RETURNING sale_id
        """, (store_id, product_id, quantity))
        sale = cur.fetchone()
        
        cur.execute("""
            UPDATE inventory 
            SET stock = stock - %s
            WHERE store_id = %s AND product_id = %s
        """, (quantity, store_id, product_id))
        
        conn.commit()
        cur.close()
        conn.close()
        
        return jsonify({
            'saleId': sale['sale_id'],
            'message': 'Sale recorded successfully'
        }), 201
        
    except Exception as e:
        conn.rollback()
        cur.close()
        conn.close()
        print(f"Sale error: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/transfers', methods=['POST'])
@jwt_required()
def create_transfer():
    data = request.get_json()
    from_store_id = data.get('fromStoreId')
    to_store_id = data.get('toStoreId')
    product_id = data.get('productId')
    quantity = data.get('quantity')
    central_warehouse = bool(data.get('isCentralWarehouse', False))

    if not all([to_store_id, product_id, quantity]) or (not central_warehouse and not from_store_id):
        return jsonify({'error': 'Missing required fields'}), 400

    try:
        to_store_id = int(to_store_id)
        product_id = int(product_id)
        quantity = int(quantity)
        from_store_id = int(from_store_id) if from_store_id is not None else to_store_id
    except (TypeError, ValueError):
        return jsonify({'error': 'Invalid transfer payload. IDs and quantity must be integers.'}), 400

    if central_warehouse:
        from_store_id = to_store_id

    if quantity <= 0:
        return jsonify({'error': 'Quantity must be greater than 0'}), 400
    
    if from_store_id == to_store_id and not central_warehouse:
        return jsonify({'error': 'Cannot transfer to same store'}), 400
    
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    
    try:
        sync_serial_sequence(cur, 'transfers', 'transfer_id')

        if not central_warehouse:
            cur.execute("""
                SELECT stock FROM inventory 
                WHERE store_id = %s AND product_id = %s
            """, (from_store_id, product_id))
            source_inventory = cur.fetchone()
            
            if not source_inventory or source_inventory['stock'] < quantity:
                available = source_inventory['stock'] if source_inventory else 0
                cur.close()
                conn.close()
                return jsonify({'error': f'Insufficient stock at source store. Available: {available}, requested: {quantity}'}), 400
        
        transport_cost = calculate_cost(from_store_id, to_store_id, quantity)
        cur.execute("""
            INSERT INTO transfers (product_id, from_store_id, to_store_id, quantity, transfer_date, cost)
            VALUES (%s, %s, %s, %s, CURRENT_DATE, %s)
            RETURNING transfer_id
        """, (product_id, from_store_id, to_store_id, quantity, transport_cost))
        transfer = cur.fetchone()
        
        if not central_warehouse:
            cur.execute("""
                UPDATE inventory 
                SET stock = stock - %s
                WHERE store_id = %s AND product_id = %s
            """, (quantity, from_store_id, product_id))
        
        cur.execute("""
            SELECT * FROM inventory 
            WHERE store_id = %s AND product_id = %s
        """, (to_store_id, product_id))
        dest_inventory = cur.fetchone()
        
        if dest_inventory:
            cur.execute("""
                UPDATE inventory 
                SET stock = stock + %s,
                    initial_stock = stock + %s,
                    stock_age = 0
                WHERE store_id = %s AND product_id = %s
            """, (quantity, quantity, to_store_id, product_id))
        else:
            cur.execute("""
                INSERT INTO inventory (product_id, store_id, stock, initial_stock, stock_age)
                VALUES (%s, %s, %s, %s, 0)
            """, (product_id, to_store_id, quantity, quantity))
        
        conn.commit()
        cur.close()
        conn.close()
        
        return jsonify({
            'transferId': transfer['transfer_id'],
            'cost': transport_cost,
            'message': 'Transfer completed successfully',
            'isCentralWarehouse': central_warehouse,
        }), 201
        
    except Exception as e:
        conn.rollback()
        cur.close()
        conn.close()
        print(f"Transfer error: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/sales/<int:store_id>', methods=['GET'])
@jwt_required()
def get_sales_history(store_id):
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    
    cur.execute("""
        SELECT s.sale_id, s.quantity, s.sale_date, 
               p.name as product_name, p.cost as product_cost,
               (s.quantity * p.cost) as total_value
        FROM sales s
        JOIN products p ON s.product_id = p.product_id
        WHERE s.store_id = %s
        ORDER BY s.sale_date DESC
        LIMIT 100
    """, (store_id,))
    sales = cur.fetchall()
    
    cur.close()
    conn.close()
    
    result = [{
        'saleId': sale['sale_id'],
        'productName': sale['product_name'],
        'quantity': sale['quantity'],
        'date': sale['sale_date'].isoformat() if sale['sale_date'] else None,
        'value': sale['total_value']
    } for sale in sales]
    
    return jsonify(result), 200

@app.route('/api/transfers/<int:store_id>', methods=['GET'])
@jwt_required()
def get_transfer_history(store_id):
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    
    cur.execute("""
        SELECT t.transfer_id, t.quantity, t.transfer_date, t.cost,
               p.name as product_name,
               s1.name as from_store_name,
               s2.name as to_store_name
        FROM transfers t
        JOIN products p ON t.product_id = p.product_id
        JOIN stores s1 ON t.from_store_id = s1.store_id
        JOIN stores s2 ON t.to_store_id = s2.store_id
        WHERE t.from_store_id = %s OR t.to_store_id = %s
        ORDER BY t.transfer_date DESC
        LIMIT 100
    """, (store_id, store_id))
    transfers = cur.fetchall()
    
    cur.close()
    conn.close()
    
    result = [{
        'transferId': transfer['transfer_id'],
        'productName': transfer['product_name'],
        'fromStore': transfer['from_store_name'],
        'toStore': transfer['to_store_name'],
        'quantity': transfer['quantity'],
        'date': transfer['transfer_date'].isoformat() if transfer['transfer_date'] else None,
        'cost': transfer['cost']
    } for transfer in transfers]
    
    return jsonify(result), 200

@app.route('/api/recommendations', methods=['GET'])
@jwt_required()
def get_recommendations():
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("""
        SELECT s.store_id, s.name as store_name,
               p.product_id, p.name as product_name,
               i.stock, i.initial_stock
        FROM stores s
        CROSS JOIN products p
        LEFT JOIN inventory i
        ON i.store_id = s.store_id AND i.product_id = p.product_id
    """)
    data = cur.fetchall()

    stores_data = {}

    for row in data:
        store_id = row['store_id']
        pid = row['product_id']
        stock = row['stock'] or 0
        initial_stock_date = row['initial_stock']

        velocity = calculate_velocity(store_id, pid)

        stock_days = stock / velocity if velocity > 0 else float('inf')

        cur.execute("""
            SELECT COALESCE(SUM(quantity),0) as total
            FROM transfers
            WHERE to_store_id = %s AND product_id = %s
        """, (store_id, pid))
        total_in = cur.fetchone()['total'] or 0

        cur.execute("""
            SELECT COALESCE(SUM(quantity),0) as total
            FROM transfers
            WHERE from_store_id = %s AND product_id = %s
        """, (store_id, pid))
        total_out = cur.fetchone()['total'] or 0

        cur.execute("""
            SELECT COALESCE(SUM(quantity),0) as total
            FROM sales
            WHERE store_id = %s AND product_id = %s
        """, (store_id, pid))
        total_sold = cur.fetchone()['total'] or 0
        initial_stock_qty = stock + total_sold + total_out - total_in
        sell_through = calculate_sell_through(store_id, pid, initial_stock_qty)
        stock_age = calculate_stock_age(store_id, pid, stock, initial_stock_date)
        status = get_status_alert(stock_days, stock_age, sell_through)

        if store_id not in stores_data:
            stores_data[store_id] = {}

        stores_data[store_id][pid] = {
            'stock': stock,
            'velocity': velocity,
            'status': status,
            'sell_through': sell_through,
            'stock_age': stock_age,
            'store_name': row['store_name'],
            'product_name': row['product_name']
        }

    solver = pywraplp.Solver.CreateSolver('SCIP')
    if not solver:
        return jsonify({'error': 'Solver creation failed'}), 500

    transfer_vars = {}
    products_ids = {p for s in stores_data.values() for p in s.keys()}
    store_ids = list(stores_data.keys())
    TARGET_OK_DAYS = 15
    MAX_OK_DAYS = 50

    def calculate_destination_deficit(status, velocity, stock):
        if velocity <= 0:
            return 0

        if status in ['UNDERSTOCK', 'AT-RISK']:
            # Target enough units so receiver moves into OK (>14 days).
            return max(1, math.ceil((TARGET_OK_DAYS * velocity) - stock))

        return 0

    def calculate_max_without_overstock(status, velocity, stock):
        if velocity <= 0 or status not in ['UNDERSTOCK', 'AT-RISK']:
            return 0

        return max(0, math.floor((MAX_OK_DAYS * velocity) - stock))

    dead_stock_best_target = {}

    def get_dead_stock_best_target(pid, from_store):
        key = (pid, from_store)
        if key in dead_stock_best_target:
            return dead_stock_best_target[key]

        candidates = []
        for to_store in store_ids:
            if to_store == from_store:
                continue

            to_data = stores_data[to_store].get(pid)
            if not to_data:
                continue

            status_to = to_data['status']
            if status_to not in ['UNDERSTOCK', 'AT-RISK']:
                continue

            need_to_ok = calculate_destination_deficit(status_to, to_data['velocity'], to_data['stock'])
            max_receivable = calculate_max_without_overstock(status_to, to_data['velocity'], to_data['stock'])

            if need_to_ok <= 0 or max_receivable <= 0:
                continue

            status_priority = 2 if status_to == 'UNDERSTOCK' else 1
            candidates.append((status_priority, max_receivable, need_to_ok, to_store))

        if not candidates:
            dead_stock_best_target[key] = None
            return None

        # Prioritize: UNDERSTOCK first, then destination that can absorb more dead stock
        # without going OVERSTOCK, then larger shortage-to-OK.
        candidates.sort(key=lambda x: (x[0], x[1], x[2]), reverse=True)
        best = candidates[0]
        dead_stock_best_target[key] = {
            'to_store': best[3],
            'deficit': best[1]
        }
        return dead_stock_best_target[key]

    for pid in products_ids:
        for from_store in store_ids:
            for to_store in store_ids:

                if from_store == to_store:
                    continue

                from_data = stores_data[from_store].get(pid)
                to_data = stores_data[to_store].get(pid)

                if not from_data or not to_data:
                    continue

                stock_from = from_data['stock']
                velocity_from = from_data['velocity']
                status_from = from_data['status']

                stock_to = to_data['stock']
                velocity_to = to_data['velocity']
                status_to = to_data['status']

                # Skip if destination is DEAD STOCK - never send transfers there
                if status_to == 'DEAD STOCK':
                    continue

                if status_from == 'DEAD STOCK':
                    best_target = get_dead_stock_best_target(pid, from_store)
                    if not best_target or to_store != best_target['to_store']:
                        continue

                    surplus = stock_from
                    deficit = best_target['deficit']

                elif status_from == 'OVERSTOCK' and velocity_from > 0:
                    max_stock = 50 * velocity_from
                    surplus = max(0, stock_from - max_stock)
                    deficit = calculate_destination_deficit(status_to, velocity_to, stock_to)

                else:
                    surplus = 0
                    deficit = calculate_destination_deficit(status_to, velocity_to, stock_to)

                max_transfer = int(min(surplus, deficit))

                if max_transfer <= 0:
                    continue

                var = solver.IntVar(
                    0,
                    max_transfer,
                    f'transfer_{pid}_{from_store}_{to_store}'
                )

                transfer_vars[(pid, from_store, to_store)] = var

    for pid in products_ids:
        for from_store in store_ids:

            vars_from = [
                v for k, v in transfer_vars.items()
                if k[0] == pid and k[1] == from_store
            ]

            from_data = stores_data[from_store].get(pid)

            if vars_from and from_data:

                stock = from_data['stock']
                velocity = from_data['velocity']
                status = from_data['status']

                if status == 'DEAD STOCK':
                    surplus = stock

                elif status == 'OVERSTOCK' and velocity > 0:
                    surplus = max(0, stock - (50 * velocity))

                else:
                    surplus = 0

                solver.Add(solver.Sum(vars_from) <= surplus)

    for pid in products_ids:
        for to_store in store_ids:

            vars_to = [
                v for k, v in transfer_vars.items()
                if k[0] == pid and k[2] == to_store
            ]

            dead_stock_vars_to = [
                v for k, v in transfer_vars.items()
                if k[0] == pid and k[2] == to_store and stores_data[k[1]][pid]['status'] == 'DEAD STOCK'
            ]

            non_dead_stock_vars_to = [
                v for k, v in transfer_vars.items()
                if k[0] == pid and k[2] == to_store and stores_data[k[1]][pid]['status'] != 'DEAD STOCK'
            ]

            to_data = stores_data[to_store].get(pid)

            if vars_to and to_data:

                stock = to_data['stock']
                velocity = to_data['velocity']
                status = to_data['status']

                deficit = calculate_destination_deficit(status, velocity, stock)
                max_without_overstock = calculate_max_without_overstock(status, velocity, stock)

                if dead_stock_vars_to:
                    solver.Add(solver.Sum(dead_stock_vars_to) <= max_without_overstock)

                if non_dead_stock_vars_to:
                    solver.Add(solver.Sum(non_dead_stock_vars_to) <= deficit)

                solver.Add(solver.Sum(vars_to) <= max_without_overstock)

    objective_terms = []
    TRANSFER_BENEFIT_PER_UNIT = 1000
    trip_vars = {}

    for (pid, f, t), var in transfer_vars.items():

        max_trips = math.ceil(var.ub() / VEHICLE_CAPACITY)
        trip_var = solver.IntVar(
            0,
            max_trips,
            f'trips_{pid}_{f}_{t}'
        )
        trip_vars[(pid, f, t)] = trip_var

        solver.Add(var <= VEHICLE_CAPACITY * trip_var)

        # Calculate priority multiplier based on source and destination status
        from_status = stores_data[f][pid]['status']
        to_status = stores_data[t][pid]['status']
        
        priority_multiplier = 1.0
        
        # Dead stock transfers get highest priority
        if from_status == 'DEAD STOCK':
            if to_status == 'UNDERSTOCK':
                priority_multiplier = 3.0  # Highest priority: dead stock to understock
            elif to_status == 'AT-RISK':
                priority_multiplier = 2.0  # Medium priority: dead stock to at-risk
        elif to_status == 'UNDERSTOCK':
            priority_multiplier = 1.5  # High priority for understock destinations
        elif to_status == 'AT-RISK':
            priority_multiplier = 1.2  # Medium priority for at-risk destinations
        
        benefit = TRANSFER_BENEFIT_PER_UNIT * priority_multiplier

        objective_terms.append(var * (-benefit))
        objective_terms.append(trip_var * calculate_trip_cost(f, t))

    solver.Minimize(solver.Sum(objective_terms))

    status = solver.Solve()

    if status != pywraplp.Solver.OPTIMAL:
        return jsonify({'error': 'No optimal solution found'}), 500

    recommendations = []

    for (pid, f, t), var in transfer_vars.items():

        qty = int(var.solution_value())

        if qty > 0:

            recommendations.append({
                'productId': pid,
                'fromStore': f,
                'toStore': t,
                'quantity': qty,
                'productName': stores_data[f][pid]['product_name'],
                'fromStoreName': stores_data[f][pid]['store_name'],
                'toStoreName': stores_data[t][pid]['store_name']
            })

    cur.close()
    conn.close()

    return jsonify(recommendations), 200

@app.route('/api/health', methods=['GET'])
def health_check():
    try:
        conn = get_db_connection()
        conn.close()
        return jsonify({'status': 'healthy', 'database': 'connected'}), 200
    except Exception as e:
        return jsonify({'status': 'unhealthy', 'database': 'disconnected', 'error': str(e)}), 500

@app.route('/api/calculate-cost', methods=['POST'])
@jwt_required()
def get_transport_cost():
    data = request.get_json()
    from_id = data.get('fromStoreId')
    to_id = data.get('toStoreId')
    quantity = data.get('quantity', 0)

    try:
        qty = int(quantity)
        if qty <= 0:
            return jsonify({'cost': 0}), 200

        cost = calculate_cost(from_id, to_id, qty)
        return jsonify({'cost': cost}), 200
    except (ValueError, TypeError):
        return jsonify({'error': 'Invalid quantity'}), 400

@app.errorhandler(Exception)
def handle_exception(e):
    print(f"Unhandled exception: {str(e)}")
    import traceback
    traceback.print_exc()
    return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    port = int(os.getenv('PORT', 3001))
    app.run(host='0.0.0.0', port=port, debug=os.getenv('FLASK_ENV') == 'development')