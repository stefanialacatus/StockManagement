import React, { useState, useEffect } from 'react';
import Login from './Login';
import Dashboard from './Dashboard';
import './App.css';

function App() {
  const [user, setUser] = useState(null);

  useEffect(() => {
    const token = sessionStorage.getItem('token');
    const storedUser = sessionStorage.getItem('user');
    if (token && storedUser) {
      setUser(JSON.parse(storedUser));
    }
  }, []);

  const handleLogin = (userData) => {
    setUser(userData);
    sessionStorage.setItem('user', JSON.stringify(userData));
  };

  const handleLogout = () => {
    setUser(null);
    sessionStorage.removeItem('token');
    sessionStorage.removeItem('user');
  };

  if (!user) {
    return <Login onLogin={handleLogin} />
  }

  return (
    <div className="app-container">
      <nav className="navbar">
        <div className="nav-brand">
          <h2 className="brand-title brand-title-nav" aria-label="StockManager">
            <span className="brand-main">Stock</span>
            <span className="brand-accent">Manager</span>
          </h2>
        </div>
        <div className="user-info">
          <span>Hello, <strong>{user.username}</strong> ({user.role})</span>
          <button onClick={handleLogout} className="btn-logout">Log Out</button>
        </div>
      </nav>
      <main className="main-content">
        <Dashboard user={user} />
      </main>
    </div>
  );
}

export default App;