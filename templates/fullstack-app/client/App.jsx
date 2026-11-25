import React, { useEffect, useState } from 'react';

export default function App() {
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    fetch('./api/health')
      .then((r) => r.json())
      .then((data) => setStatus(data.ok ? 'ready' : 'error'))
      .catch(() => setStatus('error'));
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 max-w-md w-full text-center">
        <h1 className="text-xl font-semibold text-slate-900">Atoms Starter App</h1>
        <p className="mt-2 text-sm text-slate-500">Backend SQLite status: {status}</p>
      </div>
    </div>
  );
}
