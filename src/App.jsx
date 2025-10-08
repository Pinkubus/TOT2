import React, { useEffect, useMemo, useRef, useState } from "react";

// --- Helpers ---
const K_FACTOR = 32; // Elo K-factor

function expectedScore(rA, rB) {
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}

function updateElo(winner, loser) {
  const Ea = expectedScore(winner.rating, loser.rating);
  const Eb = expectedScore(loser.rating, winner.rating);
  const newWinner = { ...winner, rating: winner.rating + K_FACTOR * (1 - Ea), wins: winner.wins + 1, comparisons: winner.comparisons + 1 };
  const newLoser = { ...loser, rating: loser.rating + K_FACTOR * (0 - Eb), losses: loser.losses + 1, comparisons: loser.comparisons + 1 };
  return { newWinner, newLoser };
}

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function pairKey(aId, bId) {
  return [aId, bId].sort().join("::");
}

// Local storage helpers
function useLocalStorage(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }, [key, value]);
  return [value, setValue];
}

// --- Main Component ---
function App() {
  const [items, setItems] = useLocalStorage("tot-items", []);
  const [seenPairs, setSeenPairs] = useLocalStorage("tot-pairs", {}); // pairKey -> count
  const [history, setHistory] = useState([]);
  const fileInputRef = useRef(null);

  // --- Upload handling ---
  async function filesToItems(files) {
    const arr = Array.from(files);
    const promises = arr.map(
      file =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            resolve({
              id: uid(),
              name: file.name,
              dataUrl: reader.result,
              rating: 1200,
              wins: 0,
              losses: 0,
              comparisons: 0,
            });
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        })
    );
    const newItems = await Promise.all(promises);
    setItems(prev => [...prev, ...newItems]);
  }

  function onFileInput(e) {
    if (e.target.files && e.target.files.length) {
      filesToItems(e.target.files);
      e.target.value = ""; // allow re-uploading same files
    }
  }

  // Drag & drop
  const [isDragging, setDragging] = useState(false);

  function handleDrop(e) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      filesToItems(e.dataTransfer.files);
    }
  }

  // --- Pair selection logic ---
  const totalUniquePairs = useMemo(() => {
    const n = items.length;
    return (n * (n - 1)) / 2;
  }, [items.length]);

  const progress = useMemo(() => {
    const uniqueSeen = Object.keys(seenPairs).length;
    return totalUniquePairs === 0 ? 0 : Math.min(100, Math.round((uniqueSeen / totalUniquePairs) * 100));
  }, [seenPairs, totalUniquePairs]);

  // pick two images: prioritize those with fewer comparisons, and avoid repeating the same pair if possible
  function getNextPair() {
    if (items.length < 2) return null;
    const sorted = [...items].sort((a, b) => a.comparisons - b.comparisons);
    // take top 40% least compared to improve coverage
    const sliceEnd = Math.max(2, Math.ceil(sorted.length * 0.4));
    const pool = sorted.slice(0, sliceEnd);
    // try up to N attempts to avoid repeats
    for (let attempt = 0; attempt < 20; attempt++) {
      const i = Math.floor(Math.random() * pool.length);
      let j = Math.floor(Math.random() * pool.length);
      if (pool.length > 1) {
        while (j === i) j = Math.floor(Math.random() * pool.length);
      }
      const A = pool[i];
      const B = pool[j];
      const key = pairKey(A.id, B.id);
      if (!seenPairs[key] || Math.random() < 0.25) {
        return [A, B];
      }
    }
    // fallback: just pick two global randoms
    let a = Math.floor(Math.random() * items.length);
    let b = Math.floor(Math.random() * items.length);
    while (b === a) b = Math.floor(Math.random() * items.length);
    return [items[a], items[b]];
  }

  const [currentPair, setCurrentPair] = useState(null);
  useEffect(() => {
    if (!currentPair && items.length >= 2) {
      setCurrentPair(getNextPair());
    }
  }, [items, currentPair]);

  // --- Actions ---
  function pickWinner(winnerId) {
    if (!currentPair) return;
    const [A, B] = currentPair;
    const winner = A.id === winnerId ? A : B;
    const loser = A.id === winnerId ? B : A;

    // snapshot for undo
    const snapshot = items.map(x => ({ ...x }));

    const { newWinner, newLoser } = updateElo(winner, loser);

    const nextItems = items.map(it => (it.id === newWinner.id ? newWinner : it.id === newLoser.id ? newLoser : it));
    setItems(nextItems);

    const key = pairKey(A.id, B.id);
    setSeenPairs(prev => ({ ...prev, [key]: (prev[key] || 0) + 1 }));

    setHistory(prev => [
      { aId: A.id, bId: B.id, winnerId, snapshot, pairKey: key },
      ...prev,
    ]);

    setCurrentPair(getNextPair());
  }

  function undo() {
    const last = history[0];
    if (!last) return;
    setItems(last.snapshot);
    setSeenPairs(prev => {
      const copy = { ...prev };
      if (copy[last.pairKey]) {
        copy[last.pairKey] -= 1;
        if (copy[last.pairKey] <= 0) delete copy[last.pairKey];
      }
      return copy;
    });
    setHistory(prev => prev.slice(1));
    setCurrentPair(getNextPair());
  }

  function resetAll() {
    if (!window.confirm("Clear all images and progress?")) return;
    setItems([]);
    setSeenPairs({});
    setHistory([]);
    setCurrentPair(null);
  }

  function clearRatings() {
    if (!window.confirm("Reset all ratings and match history (keep images)?")) return;
    setItems(prev => prev.map(x => ({ ...x, rating: 1200, wins: 0, losses: 0, comparisons: 0 })));
    setSeenPairs({});
    setHistory([]);
    setCurrentPair(getNextPair());
  }

  // export / import
  function exportData() {
    const payload = {
      version: 1,
      items,
      seenPairs,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "this-or-that-export.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function importData(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (parsed?.items && parsed?.seenPairs) {
          setItems(parsed.items);
          setSeenPairs(parsed.seenPairs);
          setHistory([]);
          setCurrentPair(null);
        } else {
          alert("Invalid file");
        }
      } catch (err) {
        alert("Failed to import");
      }
    };
    reader.readAsText(f);
    e.target.value = "";
  }

  // --- UI ---
  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-50 to-slate-100 text-slate-900">
      <header className="sticky top-0 z-10 backdrop-blur bg-white/60 border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">This-or-That Image Ranker</h1>
          <div className="flex gap-2">
            <button
              className="px-3 py-2 rounded-xl bg-slate-900 text-white text-sm shadow hover:opacity-90"
              onClick={() => fileInputRef.current?.click()}
            >
              Upload Images
            </button>
            <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={onFileInput} />

            <button className="px-3 py-2 rounded-xl bg-white border text-sm shadow-sm" onClick={exportData}>Export</button>
            <label className="px-3 py-2 rounded-xl bg-white border text-sm shadow-sm cursor-pointer">
              Import
              <input type="file" accept="application/json" className="hidden" onChange={importData} />
            </label>
            <button className="px-3 py-2 rounded-xl bg-white border text-sm shadow-sm" onClick={clearRatings}>Reset Ratings</button>
            <button className="px-3 py-2 rounded-xl bg-white border text-sm shadow-sm" onClick={resetAll}>Clear All</button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Uploader / Empty State */}
        {items.length === 0 && (
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={`col-span-1 lg:col-span-3 border-2 border-dashed rounded-2xl p-10 flex flex-col items-center justify-center text-center bg-white shadow-sm ${isDragging ? 'border-slate-900 bg-slate-50' : 'border-slate-300'}`}
          >
            <div className="text-5xl mb-4">📷</div>
            <h2 className="text-xl font-semibold mb-2">Drop images here or click Upload</h2>
            <p className="text-slate-600 mb-6">Add at least two images to start ranking. You can add more any time.</p>
            <button
              className="px-4 py-3 rounded-2xl bg-slate-900 text-white shadow hover:opacity-90"
              onClick={() => fileInputRef.current?.click()}
            >
              Choose Files
            </button>
          </div>
        )}

        {/* Arena */}
        {items.length >= 2 && (
          <div className="lg:col-span-2">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <div className="text-sm text-slate-600">Progress</div>
                <div className="w-64 h-2 bg-slate-200 rounded-full overflow-hidden">
                  <div className="h-full bg-slate-900" style={{ width: `${progress}%` }} />
                </div>
                <div className="text-xs text-slate-500 mt-1">{Object.keys(seenPairs).length} / {totalUniquePairs} unique pairs • {progress}%</div>
              </div>
              <div className="flex gap-2">
                <button className="px-3 py-2 rounded-xl bg-white border text-sm shadow-sm disabled:opacity-50" disabled={history.length === 0} onClick={undo}>Undo</button>
                <button className="px-3 py-2 rounded-xl bg-white border text-sm shadow-sm" onClick={() => setCurrentPair(getNextPair())}>Skip</button>
              </div>
            </div>

            {currentPair && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {[0, 1].map(idx => {
                  const img = currentPair[idx];
                  return (
                    <button
                      key={img.id}
                      className="group relative rounded-2xl overflow-hidden bg-white shadow border hover:shadow-md transition"
                      onClick={() => pickWinner(img.id)}
                    >
                      <div className="aspect-[4/3] w-full overflow-hidden bg-slate-100">
                        <img src={img.dataUrl} alt={img.name} className="h-full w-full object-contain" />
                      </div>
                      <div className="absolute inset-0 hidden md:flex items-center justify-center opacity-0 group-hover:opacity-100 transition">
                        <span className="px-4 py-2 rounded-xl bg-black/70 text-white text-lg font-semibold">Choose</span>
                      </div>
                      <div className="p-3 text-left">
                        <div className="text-sm font-medium truncate">{img.name}</div>
                        <div className="text-xs text-slate-500">Elo {Math.round(img.rating)} • {img.wins}W/{img.losses}L</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Leaderboard */}
        {items.length > 0 && (
          <aside className="lg:col-span-1">
            <div className="bg-white rounded-2xl shadow border p-4">
              <h3 className="text-lg font-semibold mb-3">Leaderboard</h3>
              <Leaderboard items={items} />
            </div>

            <div className="bg-white rounded-2xl shadow border p-4 mt-4">
              <h3 className="text-lg font-semibold mb-2">Gallery</h3>
              <Gallery items={items} onRemove={(id) => {
                setItems(prev => prev.filter(x => x.id !== id));
                setSeenPairs(prev => {
                  const copy = { ...prev };
                  // remove any pair keys involving this id
                  Object.keys(copy).forEach(k => {
                    const [a, b] = k.split("::");
                    if (a === id || b === id) delete copy[k];
                  });
                  return copy;
                });
                setCurrentPair(null);
              }} />
            </div>
          </aside>
        )}
      </main>

      <footer className="max-w-6xl mx-auto px-4 pb-8 text-xs text-slate-500">
        <p>Tip: you can keep adding images at any time; everything saves locally to your browser.</p>
      </footer>
    </div>
  );
}

function Leaderboard({ items }) {
  const ranked = useMemo(() => {
    return [...items].sort((a, b) => b.rating - a.rating);
  }, [items]);
  return (
    <ol className="space-y-2">
      {ranked.map((it, idx) => (
        <li key={it.id} className="flex items-center gap-3">
          <div className="w-6 text-right tabular-nums text-slate-500">{idx + 1}</div>
          <div className="w-12 h-12 rounded-xl overflow-hidden bg-slate-100 border">
            <img src={it.dataUrl} alt={it.name} className="w-full h-full object-cover" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{it.name}</div>
            <div className="text-xs text-slate-500">Elo {Math.round(it.rating)} • {it.wins}W/{it.losses}L • {it.comparisons} matches</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Gallery({ items, onRemove }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {items.map(it => (
        <div key={it.id} className="group relative rounded-xl overflow-hidden border bg-slate-50">
          <img src={it.dataUrl} alt={it.name} className="w-full h-24 object-cover" />
          <button
            onClick={() => onRemove(it.id)}
            className="absolute top-1 right-1 px-2 py-1 rounded-lg bg-white/80 border text-xs opacity-0 group-hover:opacity-100"
            title="Remove"
          >
            ✕
          </button>
          <div className="p-1 text-[10px] text-slate-600 truncate">{it.name}</div>
        </div>
      ))}
    </div>
  );
}

export default App;
