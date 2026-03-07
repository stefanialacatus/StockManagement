import React, { useEffect, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faLightbulb, faSpinner } from '@fortawesome/free-solid-svg-icons';
import { notificationService } from './notificationService';

const API_BASE = 'http://localhost:3001';

const StoreCard = ({ store, allStores, recommendations = [], onTransfer, onAddSale, user, isRefreshing = false }) => {
  const [suggestionPopup, setSuggestionPopup] = useState(null);
  const [newTransferPopup, setNewTransferPopup] = useState(null);
  const [transportCost, setTransportCost] = useState(null);
  const [saleQuantities, setSaleQuantities] = useState({});
  const [requestPopupMessage, setRequestPopupMessage] = useState(null);
  const popupTimeoutRef = useRef(null);
  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    return () => {
      if (popupTimeoutRef.current) {
        clearTimeout(popupTimeoutRef.current);
      }
    };
  }, []);

  const getStatusUI = (status) => {
    const map = {
      'DEAD STOCK': { label: 'DEAD STOCK', color: 'gray' },
      'UNDERSTOCK': { label: 'UNDERSTOCK', color: 'red' },
      'AT-RISK':    { label: 'AT RISK', color: 'orange' },
      'OVERSTOCK':  { label: 'OVERSTOCK', color: 'blue' },
      'OK':         { label: 'OK', color: 'green' }
    };
    return map[status] || map['OK'];
  };

  const findSuggestionSource = (product) => {
    const candidates = allStores
      .filter((s) => Number(s.id) !== Number(store.id))
      .map((sourceStore) => {
        const sourceProduct = sourceStore.products.find((p) => Number(p.id) === Number(product.id));
        if (!sourceProduct || (sourceProduct.stock || 0) <= 0) return null;

        return {
          store: sourceStore,
          product: sourceProduct,
          quantity: Math.max(1, Math.floor(sourceProduct.stock * 0.3)),
        };
      })
      .filter(Boolean)
      .sort((a, b) => (b.product.stock || 0) - (a.product.stock || 0));

    return candidates.length > 0 ? candidates[0] : null;
  };

  const findBackendSuggestion = (productId) => recommendations.find(
    (r) => Number(r.productId) === Number(productId) && Number(r.toStore) === Number(store.id)
  );

  const findDeadStockDestinations = (productId) => recommendations.filter(
    (r) => Number(r.productId) === Number(productId) && Number(r.fromStore) === Number(store.id)
  );

  const findDeadStockFallbackDestination = (product) => {
    const TARGET_OK_DAYS = 15;
    const MAX_OK_DAYS = 50;

    const candidates = allStores
      .filter((s) => Number(s.id) !== Number(store.id))
      .map((destinationStore) => {
        const destinationProduct = destinationStore.products.find((p) => Number(p.id) === Number(product.id));
        if (!destinationProduct) return null;

        const status = destinationProduct.status;
        if (status !== 'UNDERSTOCK' && status !== 'AT-RISK') return null;

        const velocity = Number(destinationProduct.velocity || 0);
        const destinationStock = Number(destinationProduct.stock || 0);
        if (velocity <= 0) return null;

        const neededForOk = Math.max(1, Math.ceil((TARGET_OK_DAYS * velocity) - destinationStock));
        const maxWithoutOverstock = Math.max(0, Math.floor((MAX_OK_DAYS * velocity) - destinationStock));
        if (maxWithoutOverstock <= 0) return null;

        return {
          store: destinationStore,
          priority: status === 'UNDERSTOCK' ? 2 : 1,
          neededForOk,
          maxWithoutOverstock,
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        if (b.maxWithoutOverstock !== a.maxWithoutOverstock) {
          return b.maxWithoutOverstock - a.maxWithoutOverstock;
        }
        return b.neededForOk - a.neededForOk;
      });

    if (candidates.length === 0) return null;

    const best = candidates[0];
    return {
      store: best.store,
      quantity: Math.min(Number(product.stock || 0), best.maxWithoutOverstock),
    };
  };

  const fetchTransportCost = async (quantity, fromStoreId, toStoreId) => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${API_BASE}/api/calculate-cost`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          quantity: parseInt(quantity),
          fromStoreId: parseInt(fromStoreId),
          toStoreId: parseInt(toStoreId)
        })
      });
      const data = await response.json();
      return data.cost;
    } catch (error) {
      console.error("Failed to fetch transport cost:", error);
      return 0;
    }
  };

  const handleLightbulbClick = async (product) => {
    if (product.status === 'DEAD STOCK') {
      const destinations = findDeadStockDestinations(product.id);

      if (destinations.length > 0) {
        const destination = destinations[0];
        const destStore = allStores.find(s => Number(s.id) === Number(destination.toStore));
        if (!destStore) return;

        const cost = await fetchTransportCost(destination.quantity, store.id, destination.toStore);

        setSuggestionPopup({
          product,
          isDeadStock: true,
          suggestion: {
            store: destStore,
            quantity: destination.quantity
          },
          cost
        });
        return;
      }

      const fallbackDestination = findDeadStockFallbackDestination(product);
      if (!fallbackDestination || fallbackDestination.quantity <= 0) return;

      const fallbackCost = await fetchTransportCost(
        fallbackDestination.quantity,
        store.id,
        fallbackDestination.store.id
      );

      setSuggestionPopup({
        product,
        isDeadStock: true,
        suggestion: {
          store: fallbackDestination.store,
          quantity: fallbackDestination.quantity
        },
        cost: fallbackCost
      });
      return;
    }

    const suggestion = findBackendSuggestion(product.id);
    
    if (suggestion) {
      const sourceStore = allStores.find(s => s.id === suggestion.fromStore);
      const cost = await fetchTransportCost(suggestion.quantity, suggestion.fromStore, store.id);
      
      setSuggestionPopup({
        product,
        isDeadStock: false,
        suggestion: {
          store: sourceStore,
          quantity: suggestion.quantity
        },
        cost
      });
      return;
    }

    const fallback = findSuggestionSource(product);
    if (!fallback) return;

    const cost = await fetchTransportCost(fallback.quantity, fallback.store.id, store.id);

    setSuggestionPopup({
      product,
      isDeadStock: false,
      suggestion: {
        store: fallback.store,
        quantity: fallback.quantity
      },
      cost
    });
  };

  const handleApproveSuggestion = () => {
    if (suggestionPopup) {
      if (suggestionPopup.isDeadStock) {
        onTransfer(
          store.id,
          suggestionPopup.suggestion.store.id,
          suggestionPopup.suggestion.quantity,
          suggestionPopup.product.id
        );
      } else {
        onTransfer(
          suggestionPopup.suggestion.store.id,
          store.id,
          suggestionPopup.suggestion.quantity,
          suggestionPopup.product.id
        );
      }
      setSuggestionPopup(null);
    }
  };

  const handleNewTransfer = async () => {
    if (suggestionPopup) {
      if (suggestionPopup.isDeadStock) {
        setNewTransferPopup({
          product: suggestionPopup.product,
          fromStore: store,
          toStore: suggestionPopup.suggestion.store,
          quantity: suggestionPopup.suggestion.quantity,
          isDeadStock: true
        });
        const cost = await fetchTransportCost(suggestionPopup.suggestion.quantity, store.id, suggestionPopup.suggestion.store.id);
        setTransportCost(cost);
      } else {
        setNewTransferPopup({
          product: suggestionPopup.product,
          toStore: store,
          fromStore: suggestionPopup.suggestion.store,
          quantity: suggestionPopup.suggestion.quantity,
          isDeadStock: false
        });
        const cost = await fetchTransportCost(suggestionPopup.suggestion.quantity, suggestionPopup.suggestion.store.id, store.id);
        setTransportCost(cost);
      }
      setSuggestionPopup(null);
    }
  };

  const handleCheckCost = async (quantity, fromStoreId, toStoreId) => {
    const cost = await fetchTransportCost(quantity, fromStoreId, toStoreId);
    setTransportCost(cost);
  };

  const handleConfirmNewTransfer = (fromId, toId, quantity) => {
    if (newTransferPopup) {
      onTransfer(
        parseInt(fromId),
        parseInt(toId),
        parseInt(quantity),
        newTransferPopup.product.id
      );
      setNewTransferPopup(null);
      setTransportCost(null);
    }
  };

  const handleRequestTransfer = (product, statusLabel) => {
    notificationService.addNotification(
      store.id,
      store.name,
      product.id,
      product.name,
      statusLabel
    );

    setRequestPopupMessage(`Transfer request sent for ${product.name}.`);
    if (popupTimeoutRef.current) clearTimeout(popupTimeoutRef.current);
    
    popupTimeoutRef.current = setTimeout(() => {
      setRequestPopupMessage(null);
      popupTimeoutRef.current = null;
    }, 2500);
  };

  return (
    <>
      <div className={`store-card-table ${isRefreshing ? 'is-loading' : ''}`}>
        <div className="store-header">
          <h3>{store.name}</h3>
          <span className="store-city">{store.location}</span>
        </div>
        
        <table className="products-table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Sale Velocity (units/day)</th>
              <th>Stock Days</th>
              <th>Stock</th>
              <th>Status</th>
              {!isAdmin && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {store.products.map((product) => {
              const ui = getStatusUI(product.status);
              const isAtRiskOrUnderstock = product.status === 'AT-RISK' || product.status === 'UNDERSTOCK';
              const isDeadStock = product.status === 'DEAD STOCK';
              const hasBackendSuggestion = !!findBackendSuggestion(product.id);
              const hasFallbackSuggestion = isAtRiskOrUnderstock && !!findSuggestionSource(product);
              
              const deadStockDestinations = isDeadStock ? findDeadStockDestinations(product.id) : [];
              const hasDeadStockFallbackDestination = isDeadStock && !!findDeadStockFallbackDestination(product);
              const hasDeadStockDestination = isDeadStock && (deadStockDestinations.length > 0 || hasDeadStockFallbackDestination);
              
              const shouldShowLightbulb = isAdmin && (hasBackendSuggestion || hasFallbackSuggestion || hasDeadStockDestination);
              
              return (
                <tr key={product.id}>
                  <td className="product-name">{product.name}</td>
                  <td className="velocity-cell">{product.velocity.toFixed(1)}</td>
                  <td className="days-cell">{product.daysInStock} days</td>
                  <td className="stock-cell">{product.stock} units</td>
                  <td className="status-cell">
                    <div className="status-row">
                      <span className={`status-badge status-${ui.color}`}>
                        {ui.label}
                      </span>
                      {shouldShowLightbulb && (
                        <button 
                          className="lightbulb-btn"
                          onClick={() => handleLightbulbClick(product)}
                          title="View transfer suggestion"
                        >
                          <FontAwesomeIcon
                            icon={faLightbulb}
                            beat
                            style={{ color: 'rgb(255, 212, 59)' }}
                          />
                        </button>
                      )}
                    </div>
                  </td>
                  {!isAdmin && (
                    <td className="actions-cell">
                      <div className="product-actions">
                        <div className="sale-input-group">
                          <input
                            type="number"
                            min="1"
                            value={saleQuantities[product.id] || 1}
                            onChange={(e) => setSaleQuantities({...saleQuantities, [product.id]: parseInt(e.target.value)})}
                            className="product-qty-input"
                            placeholder="Qty"
                          />
                          <button
                            className="btn-add-product-sale"
                            onClick={() => {
                              const qty = saleQuantities[product.id] || 1;
                              onAddSale(store.id, product.id, qty);
                              setSaleQuantities({...saleQuantities, [product.id]: 1});
                            }}
                          >
                            + Sale
                          </button>
                        </div>
                        {(product.status === 'UNDERSTOCK' || product.status === 'AT-RISK') && (
                          <button
                            className="btn-request-transfer"
                            onClick={() => handleRequestTransfer(product, ui.label)}
                          >
                            Request Transfer
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>

        {isRefreshing && (
          <div className="store-card-loading-overlay" role="status" aria-live="polite">
            <FontAwesomeIcon icon={faSpinner} spin style={{color: 'rgb(30, 48, 80)', fontSize: '44px'}} />
          </div>
        )}
      </div>

      {suggestionPopup && (
        <div className="modal-overlay">
          <div className="suggestion-modal">
            <button className="close-btn" onClick={() => setSuggestionPopup(null)}>✕</button>
            <h3>{suggestionPopup.isDeadStock ? 'Dead Stock Transfer Recommendation' : 'Stock Transfer Suggestion'}</h3>
            <div className="suggestion-content">
              <div className="suggestion-info">
                <p><strong>Product:</strong> {suggestionPopup.product.name}</p>
                <p><strong>Current Stock:</strong> {suggestionPopup.product.stock} units</p>
                <p><strong>Suggested Quantity:</strong> {suggestionPopup.suggestion.quantity} units</p>
                <p><strong>From Store:</strong> {suggestionPopup.isDeadStock ? store.name : suggestionPopup.suggestion.store?.name}</p>
                <p><strong>To Store:</strong> {suggestionPopup.isDeadStock ? suggestionPopup.suggestion.store?.name : store.name}</p>
                <p className="transport-cost"><strong>Transport Cost:</strong> ${suggestionPopup.cost}</p>
              </div>
            </div>
            <div className="suggestion-btns">
              <button className="btn-approve" onClick={handleApproveSuggestion}>
                Approve Transfer
              </button>
              <button className="btn-new-transfer" onClick={handleNewTransfer}>
                New Transfer (Custom)
              </button>
            </div>
          </div>
        </div>
      )}

      {newTransferPopup && (
        <div className="modal-overlay">
          <div className="transfer-modal">
            <button className="close-btn" onClick={() => {
              setNewTransferPopup(null);
              setTransportCost(null);
            }}>✕</button>
            
            <h3>Custom Stock Transfer</h3>
            
            <div className="transfer-form">
              <div className="input-group">
                <label>Product</label>
                <input type="text" value={newTransferPopup.product.name} disabled className="disabled-input" />
              </div>

              <div className="input-group">
                <label>From Store (Source)</label>
                {newTransferPopup.isDeadStock ? (
                  <input type="text" value={store.name} disabled className="disabled-input" />
                ) : (
                  <select 
                    value={newTransferPopup.fromStore.id}
                    onChange={(e) => {
                      const newFrom = allStores.find(s => s.id === parseInt(e.target.value));
                      setNewTransferPopup({...newTransferPopup, fromStore: newFrom});
                      setTransportCost(null);
                    }}
                    className="form-select"
                  >
                    {allStores
                      .filter(s => s.id !== store.id)
                      .map(s => {
                        const prod = s.products.find(p => p.id === newTransferPopup.product.id);
                        return (
                          <option key={s.id} value={s.id}>
                            {s.name} ({prod?.stock || 0} units available)
                          </option>
                        );
                      })}
                  </select>
                )}
              </div>

              <div className="input-group">
                <label>To Store (Destination)</label>
                {newTransferPopup.isDeadStock ? (
                  <select 
                    value={newTransferPopup.toStore.id}
                    onChange={(e) => {
                      const newTo = allStores.find(s => s.id === parseInt(e.target.value));
                      setNewTransferPopup({...newTransferPopup, toStore: newTo});
                      setTransportCost(null);
                    }}
                    className="form-select"
                  >
                    {allStores
                      .filter(s => s.id !== store.id)
                      .map(s => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                ) : (
                  <input type="text" value={store.name} disabled className="disabled-input" />
                )}
              </div>

              <div className="input-group">
                <label>Quantity</label>
                <input 
                  type="number" 
                  value={newTransferPopup.quantity}
                  onChange={(e) => {
                    setNewTransferPopup({...newTransferPopup, quantity: parseInt(e.target.value)});
                    setTransportCost(null);
                  }}
                  min="1"
                  className="form-input"
                />
              </div>

              <button 
                className="btn-check-cost"
                onClick={() => handleCheckCost(newTransferPopup.quantity, newTransferPopup.fromStore.id, newTransferPopup.toStore.id)}
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
              <button className="btn-cancel" onClick={() => {setNewTransferPopup(null); setTransportCost(null);}}>
                Cancel
              </button>
              <button 
                className="btn-confirm-transfer"
                onClick={() => handleConfirmNewTransfer(newTransferPopup.fromStore.id, newTransferPopup.toStore.id, newTransferPopup.quantity)}
              >
                Confirm Transfer
              </button>
            </div>
          </div>
        </div>
      )}

      {requestPopupMessage && !isAdmin && (
        <div className="request-popup" role="status" aria-live="polite">
          <div className="request-popup-icon">✓</div>
          <div className="request-popup-text">{requestPopupMessage}</div>
          <button className="request-popup-close" onClick={() => setRequestPopupMessage(null)}>✕</button>
        </div>
      )}
    </>
  );
};

export default StoreCard;