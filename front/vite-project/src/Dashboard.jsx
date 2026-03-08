import React, { useState, useEffect } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSpinner } from '@fortawesome/free-solid-svg-icons';
import StoreCard from './StoreCard';
import Notifications from './Notifications';

const API_BASE = 'http://localhost:3001';
const CENTRAL_WAREHOUSE_VALUE = 'CENTRAL_WAREHOUSE';

const Dashboard = ({ user }) => {
  const [stores, setStores] = useState([]);
  const [recommendations, setRecommendations] = useState([]);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [isTransferOpen, setTransferOpen] = useState(false);
  const [transportCost, setTransportCost] = useState(null);
  const [transferForm, setTransferForm] = useState({
    fromStoreId: '',
    toStoreId: '',
    productId: '',
    quantity: 5,
  });

  useEffect(() => {
    fetchAllData();
  }, []);

  const fetchAllData = async () => {
    setIsInitialLoading(true);
    await Promise.all([fetchStores(true), fetchRecommendations()]);
    setIsInitialLoading(false);
  };

  const fetchRecommendations = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${API_BASE}/api/recommendations`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (response.ok) {
        const data = await response.json();

        const rawRecommendations = Array.isArray(data)
          ? data
          : Array.isArray(data?.recommendations)
            ? data.recommendations
            : [];

        const normalizedRecommendations = rawRecommendations.map((item) => ({
          productId: Number(item.productId ?? item.product_id),
          fromStore: Number(item.fromStore ?? item.from_store),
          toStore: Number(item.toStore ?? item.to_store),
          quantity: Number(item.quantity ?? 0),
          productName: item.productName ?? item.product_name,
          fromStoreName: item.fromStoreName ?? item.from_store_name,
          toStoreName: item.toStoreName ?? item.to_store_name,
        })).filter((item) => Number.isFinite(item.productId) && Number.isFinite(item.fromStore) && Number.isFinite(item.toStore) && item.quantity > 0);

        setRecommendations(normalizedRecommendations);
      } else {
        setRecommendations([]);
      }
    } catch (err) {
      console.error('Error fetching recommendations:', err);
      setRecommendations([]);
    }
  };

  const fetchStores = async (silent = false) => {
    try {
      if (silent) {
        setIsRefreshing(true);
      } else {
        setIsInitialLoading(true);
      }

      const token = localStorage.getItem('token');
      const response = await fetch(`${API_BASE}/api/stores`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch stores');
      }

      const data = await response.json();
      setStores(data);
      setError('');
    } catch (err) {
      setError(err.message);
      console.error('Error fetching stores:', err);
    } finally {
      if (silent) {
        setIsRefreshing(false);
      } else {
        setIsInitialLoading(false);
      }
    }
  };

  const visibleStores = user.role === 'admin'
    ? stores
    : stores.filter((s) => s.id === Number(user.storeId));

  const getProductsForStore = (fromStoreId, toStoreId) => {
    if (fromStoreId === CENTRAL_WAREHOUSE_VALUE) {
      const destinationStore = stores.find((s) => s.id === parseInt(toStoreId));
      return destinationStore ? destinationStore.products : [];
    }

    const sourceStore = stores.find((s) => s.id === parseInt(fromStoreId));
    if (!sourceStore) return [];
    return sourceStore.products.filter((p) => (p.stock || 0) > 0);
  };

  const handleCheckCost = async () => {
    const qty = parseInt(transferForm.quantity);
    const toId = parseInt(transferForm.toStoreId);

    if (qty && toId) {
      if (transferForm.fromStoreId === CENTRAL_WAREHOUSE_VALUE) {
        setTransportCost(50);
      } else {
        const fromId = parseInt(transferForm.fromStoreId);
        if (fromId) {
          try {
            const token = localStorage.getItem('token');
            const response = await fetch(`${API_BASE}/api/calculate-cost`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
              },
              body: JSON.stringify({
                fromStoreId: fromId,
                toStoreId: toId,
                quantity: qty,
              }),
            });

            if (!response.ok) {
              throw new Error('Could not calculate transport cost');
            }

            const data = await response.json();
            setTransportCost(data.cost ?? 0);
          } catch (err) {
            console.error('Cost calculation failed:', err);
            setTransportCost(null);
            alert(err.message || 'Could not calculate transport cost');
          }
        }
      }
    }
  };

  const handleTransfer = async (fromId, toId, quantity, productId, isCentralWarehouse = false) => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${API_BASE}/api/transfers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          fromStoreId: parseInt(fromId),
          toStoreId: parseInt(toId),
          productId: parseInt(productId),
          quantity: parseInt(quantity),
          isCentralWarehouse,
        }),
      });

      if (!response.ok) {
        let errorMessage = 'Transfer failed';
        try {
          const errorData = await response.json();
          if (errorData?.error) {
            errorMessage = errorData.error;
          }
        } catch (_) {
        }
        throw new Error(errorMessage);
      }
      await Promise.all([fetchStores(true), fetchRecommendations()]);
    } catch (err) {
      console.error('Error processing transfer:', err);
      alert('Transfer failed: ' + err.message);
    }
  };

  const handleNewTransferClick = () => {
    const defaultFrom = stores[0]?.id || '';
    const defaultTo = stores.find((s) => s.id !== defaultFrom)?.id || stores[0]?.id || '';
    const defaultProducts = getProductsForStore(defaultFrom, defaultTo);
    const defaultProduct = defaultProducts[0]?.id || '';

    setTransferForm({
      fromStoreId: defaultFrom,
      toStoreId: defaultTo,
      productId: defaultProduct,
      quantity: 5,
    });
    setTransferOpen(true);
    setTransportCost(null);
  };

  const handleTransferFormChange = (field, value) => {
    if (field === 'fromStoreId') {
      const products = getProductsForStore(value, transferForm.toStoreId);
      const nextProductId = products[0]?.id || '';
      setTransferForm((prev) => ({ ...prev, fromStoreId: value, productId: nextProductId }));
      setTransportCost(null);
      return;
    }

    if (field === 'toStoreId') {
      const products = getProductsForStore(transferForm.fromStoreId, value);
      const nextProductId = products.some((p) => p.id === transferForm.productId)
        ? transferForm.productId
        : (products[0]?.id || '');

      setTransferForm((prev) => ({ ...prev, toStoreId: value, productId: nextProductId }));
      setTransportCost(null);
      return;
    }

    setTransferForm((prev) => ({ ...prev, [field]: value }));
    if (field === 'toStoreId' || field === 'quantity' || field === 'productId') {
      setTransportCost(null);
    }
  };

  const handleAddSale = async (storeId, productId, quantity) => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${API_BASE}/api/sales`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          storeId: parseInt(storeId),
          productId: parseInt(productId),
          quantity: parseInt(quantity),
        }),
      });

      if (!response.ok) {
        let errorMessage = 'Sale failed';
        try {
          const errorData = await response.json();
          if (errorData?.error) {
            errorMessage = errorData.error;
          }
        } catch (_) {
        }
        throw new Error(errorMessage);
      }
      await Promise.all([fetchStores(true), fetchRecommendations()]);
    } catch (err) {
      console.error('Error recording sale:', err);
      alert('Sale failed: ' + err.message);
    }
  };

  if (isInitialLoading) {
    return (
      <div className="dashboard-container">
        <header className="dashboard-header">
          <div>
            <h3>{user.role === 'admin' ? 'Inventory Overview - All Stores' : 'Inventory Overview - My Store'}</h3>          </div>
        </header>

        <div className={`store-grid-table ${user.role !== 'admin' ? 'seller-view' : ''}`}>
          <div className="store-card-table placeholder-loading">
            <div className="store-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flex: 1 }}>
                <div className="skeleton-text" style={{ width: '150px', height: '24px' }} />
                <div className="skeleton-text" style={{ width: '80px', height: '20px' }} />
              </div>
            </div>
            <table style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ padding: '0.75rem', textAlign: 'left' }}>
                    <div className="skeleton-text" style={{ width: '80px', height: '16px' }} />
                  </th>
                  <th style={{ padding: '0.75rem', textAlign: 'left' }}>
                    <div className="skeleton-text" style={{ width: '60px', height: '16px' }} />
                  </th>
                  <th style={{ padding: '0.75rem', textAlign: 'left' }}>
                    <div className="skeleton-text" style={{ width: '70px', height: '16px' }} />
                  </th>
                  <th style={{ padding: '0.75rem', textAlign: 'left' }}>
                    <div className="skeleton-text" style={{ width: '80px', height: '16px' }} />
                  </th>
                </tr>
              </thead>
              <tbody>
                {[1, 2, 3, 4, 5].map((row) => (
                  <tr key={row}>
                    <td style={{ padding: '0.75rem' }}>
                      <div className="skeleton-text" style={{ width: '100px', height: '16px' }} />
                    </td>
                    <td style={{ padding: '0.75rem' }}>
                      <div className="skeleton-text" style={{ width: '40px', height: '16px' }} />
                    </td>
                    <td style={{ padding: '0.75rem' }}>
                      <div className="skeleton-text" style={{ width: '50px', height: '16px' }} />
                    </td>
                    <td style={{ padding: '0.75rem' }}>
                      <div className="skeleton-text" style={{ width: '60px', height: '16px' }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="dashboard-content-wrap is-loading">
          <div className="dashboard-loading-overlay" role="status" aria-live="polite">
            <FontAwesomeIcon icon={faSpinner} spin style={{color: 'rgb(30, 48, 80)', fontSize: '44px'}} />
            <p>Loading tables...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error && stores.length === 0) {
    return (
      <div className="dashboard-container">
        <p style={{ textAlign: 'center', color: '#ef4444', marginTop: '2rem' }}>Error: {error}</p>
      </div>
    );
  }

  if (user.role !== 'admin' && visibleStores.length === 0) {
    return (
      <div className="dashboard-container">
        <p style={{ textAlign: 'center', color: '#ef4444', marginTop: '2rem' }}>
          No store is assigned to this user. Please set `users.store_id` for this account.
        </p>
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <div>
          <h3>{user.role === 'admin' ? 'Inventory Overview - All Stores' : 'Inventory Overview - My Store'}</h3>
        </div>
        {user.role === 'admin' && (
          <button className="btn-primary" onClick={handleNewTransferClick}>
            New Transfer
          </button>
        )}
      </header>

      {user.role === 'admin' && <Notifications />}

      {error && stores.length > 0 && (
        <p className="dashboard-inline-error">Error refreshing data: {error}</p>
      )}

      <div className="dashboard-content-wrap">
        <div className={`store-grid-table ${user.role !== 'admin' ? 'seller-view' : ''}`}>
        {visibleStores.map(store => (
          <StoreCard 
            key={store.id} 
            store={store}
            allStores={stores}
            recommendations={recommendations}
            onTransfer={handleTransfer}
            onAddSale={handleAddSale}
            user={user}
            isRefreshing={isRefreshing}
          />
        ))}
        </div>
      </div>

      {isTransferOpen && (
        <div className="modal-overlay">
          <div className="transfer-modal">
            <button 
              className="close-btn" 
              onClick={() => {
                setTransferOpen(false);
                setTransportCost(null);
              }}
            >
              ✕
            </button>
            
            <h3>New Stock Transfer</h3>
            
            <div className="transfer-form">
              <div className="input-group">
                <label>From Store (Source)</label>
                <select 
                  id="from-store-select"
                  value={transferForm.fromStoreId}
                  onChange={(e) => {
                    const selected = e.target.value;
                    const value = selected === CENTRAL_WAREHOUSE_VALUE ? selected : parseInt(selected);
                    handleTransferFormChange('fromStoreId', value);
                  }}
                  className="form-select"
                >
                  <option value={CENTRAL_WAREHOUSE_VALUE}>Central Warehouse</option>
                  {stores.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="input-group">
                <label>To Store (Destination)</label>
                <select 
                  id="to-store-select"
                  value={transferForm.toStoreId}
                  onChange={(e) => handleTransferFormChange('toStoreId', parseInt(e.target.value))}
                  className="form-select"
                >
                  {stores.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="input-group">
                <label>Product</label>
                <select
                  id="transfer-product-select"
                  value={transferForm.productId}
                  onChange={(e) => handleTransferFormChange('productId', parseInt(e.target.value))}
                  className="form-select"
                >
                  {getProductsForStore(transferForm.fromStoreId, transferForm.toStoreId).map((p) => (
                    <option key={p.id} value={p.id}>
                      {transferForm.fromStoreId === CENTRAL_WAREHOUSE_VALUE ? p.name : `${p.name} (${p.stock} units)`}
                    </option>
                  ))}
                </select>
              </div>

              <div className="input-group">
                <label>Quantity</label>
                <input 
                  type="number" 
                  id="transfer-qty"
                  min="1"
                  value={transferForm.quantity}
                  onChange={(e) => handleTransferFormChange('quantity', parseInt(e.target.value) || 1)}
                  className="form-input"
                />
              </div>

              <button 
                className="btn-check-cost"
                onClick={handleCheckCost}
              >
                Check Transport Cost
              </button>

              {transportCost !== null && (
                <div className="cost-display">
                  <strong>Transport Cost: ${transportCost}</strong>
                </div>
              )}
            </div>
            
            <div className="transfer-btns">
              <button 
                className="btn-cancel" 
                onClick={() => {
                  setTransferOpen(false);
                  setTransportCost(null);
                }}
              >
                Cancel
              </button>
              <button 
                className="btn-confirm-transfer"
                onClick={() => {
                  const toId = transferForm.toStoreId;
                  const isCentralWarehouse = transferForm.fromStoreId === CENTRAL_WAREHOUSE_VALUE;
                  const fromId = isCentralWarehouse ? toId : transferForm.fromStoreId;
                  const qty = transferForm.quantity;
                  const productId = transferForm.productId;

                  if (fromId && toId && qty && productId) {
                    handleTransfer(fromId, toId, qty, productId, isCentralWarehouse);
                    setTransferOpen(false);
                    setTransportCost(null);
                  }
                }}
              >
                Confirm Transfer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;