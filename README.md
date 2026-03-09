# StockManagement

StockManagement is a web application that analyzes inventory levels and sales velocity to recommend optimal stock transfers between store locations. The system helps businesses optimize inventory distribution, reduce dead stock, and minimize transportation costs.

### Features:
- Authentication as admin or store manager
- **Admin**: Inventory monitoring across all store locations; Authorizes stock transfers
- **Store Manager**: Inventory monitoring for the alocated store; Records sales and requests stock transfers
- Sales velocity analysis
- Stock Status alerts (Understock, OK, At Risk, Overstock, Dead Stock)
- Automatic stock transfer recommendations

### Tech Stack:
- Frontend: React, CSS
- Backend: Python, Flask, OR-Tools, JWT authentication
- Database: PostgreSQL
