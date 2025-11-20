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

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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
  // Tournament state: null when not running
  const [tState, setTState] = useLocalStorage("tot-tournament", null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const deletionTimerRef = useRef(null);
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

  // Helper: compute next tournament match pair from queue or build next round
  function computeNextTournamentPair(nextTState) {
    let ts = nextTState ?? tState;
    if (!ts) return null;
    // Remove any pairs that reference missing ids
    const validIds = new Set(items.map(i => i.id));
    let mq = (ts.matchQueue || []).filter(([a, b]) => validIds.has(a) && validIds.has(b));
    let activeIds = (ts.activeIds || []).filter(id => validIds.has(id));
    let eliminatedIds = (ts.eliminatedIds || []).filter(id => validIds.has(id));

    // If queue empty, build next round if needed
    if (mq.length === 0) {
      // Champion detection
      if (activeIds.length <= 1) {
        const champId = activeIds[0] || null;
        const updated = { ...ts, matchQueue: [], championId: champId, activeIds, eliminatedIds };
        setTState(updated);
        return null;
      }
      // Build matches by loss tier (0,1,2)
      const lossTiers = { 0: [], 1: [], 2: [] };
      items.forEach(it => {
        if (activeIds.includes(it.id)) {
          const l = Math.min(2, Math.max(0, it.losses || 0));
          lossTiers[l].push(it.id);
        }
      });
      const buildPairs = (ids) => {
        const out = [];
        const s = shuffle(ids);
        while (s.length >= 2) {
          const a = s.shift();
          const b = s.shift();
          out.push([a, b]);
        }
        // If odd count, leftover gets bye (no match this round)
        // We simply keep them in activeIds; they'll appear next round again.
        return out;
      };
      const tierPairs = [
        ...buildPairs(lossTiers[0]),
        ...buildPairs(lossTiers[1]),
        ...buildPairs(lossTiers[2]),
      ];
      mq = tierPairs;
      const updated = { ...ts, matchQueue: mq, championId: null, activeIds, eliminatedIds, currentRound: (ts.currentRound || 0) + 1 };
      setTState(updated);
    } else if (ts.matchQueue !== mq) {
      setTState({ ...ts, matchQueue: mq, activeIds, eliminatedIds });
    }

    if (mq.length === 0) return null;
    const [aId, bId] = mq[0];
    const A = items.find(x => x.id === aId);
    const B = items.find(x => x.id === bId);
    if (!A || !B) return null;
    return [A, B];
  }

  useEffect(() => {
    if (tState) {
      setCurrentPair(computeNextTournamentPair());
    } else if (!currentPair && items.length >= 2) {
      setCurrentPair(getNextPair());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, currentPair, tState?.matchQueue, tState?.activeIds, tState?.championId]);

  // Keyboard controls: Left/Right select winner, Delete toggles delete-armed, Esc cancels
  useEffect(() => {
    function onKeyDown(e) {
      if (!currentPair) return;
      if (deletingId) {
        // If a deletion animation is in progress, ignore keys
        e.preventDefault();
        return;
      }
      if (e.key === "Delete") {
        setDeleteArmed(prev => !prev);
        e.preventDefault();
        return;
      }
      if (e.key === "Escape") {
        if (deleteArmed) {
          setDeleteArmed(false);
          e.preventDefault();
        }
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const target = e.key === "ArrowLeft" ? currentPair[0] : currentPair[1];
        if (deleteArmed) {
          // Show deletion overlay briefly before removing
          setDeletingId(target.id);
          setDeleteArmed(false);
          if (deletionTimerRef.current) clearTimeout(deletionTimerRef.current);
          deletionTimerRef.current = setTimeout(() => {
            removeItem(target.id);
            setDeletingId(null);
            deletionTimerRef.current = null;
          }, 550);
        } else {
          pickWinner(target.id);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [currentPair, deleteArmed, deletingId]);

  // Cleanup deletion timer on unmount
  useEffect(() => {
    return () => {
      if (deletionTimerRef.current) {
        clearTimeout(deletionTimerRef.current);
      }
    };
  }, []);

  // --- Actions ---
  function pickWinner(winnerId) {
    if (!currentPair) return;
    const [A, B] = currentPair;
    const winner = A.id === winnerId ? A : B;
    const loser = A.id === winnerId ? B : A;

    if (tState) {
      // Tournament mode: update wins/losses, eliminate at 3 losses, advance queue
      const snapshot = items.map(x => ({ ...x }));
      const updatedItems = items.map(it => {
        if (it.id === winner.id) return { ...it, wins: (it.wins || 0) + 1 };
        if (it.id === loser.id) return { ...it, losses: (it.losses || 0) + 1 };
        return it;
      });
      // Advance queue
      const [, ...restQueue] = (tState.matchQueue || []);
      // Eliminate if needed
      const loserAfter = updatedItems.find(x => x.id === loser.id);
      let newActive = (tState.activeIds || []).filter(id => id !== loser.id);
      let newElim = [...(tState.eliminatedIds || [])];
      if ((loserAfter.losses || 0) < 3) {
        if (!newActive.includes(loser.id)) newActive.push(loser.id);
      } else {
        if (!newElim.includes(loser.id)) newElim.push(loser.id);
      }
      // Winner remains active by default
      if (!newActive.includes(winner.id)) newActive.push(winner.id);

      setItems(updatedItems);
      setHistory(prev => [{ aId: A.id, bId: B.id, winnerId, snapshot, pairKey: pairKey(A.id, B.id) }, ...prev]);
      setTState(prev => ({
        ...(prev || {}),
        matchQueue: restQueue,
        activeIds: newActive.filter(id => !newElim.includes(id)),
        eliminatedIds: newElim,
      }));
      // Next pair will be computed by effect
      return;
    }

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
    if (tState) {
      alert("Undo is not supported during the tournament.");
      return;
    }
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
    setTState(null);
    setDeleteArmed(false);
  }

  function clearRatings() {
    if (!window.confirm("Reset all ratings and match history (keep images)?")) return;
    setItems(prev => prev.map(x => ({ ...x, rating: 1200, wins: 0, losses: 0, comparisons: 0 })));
    setSeenPairs({});
    setHistory([]);
    setCurrentPair(getNextPair());
  }

  // Centralized remove handler used by keyboard delete-armed and gallery
  function removeItem(id) {
    setItems(prev => prev.filter(x => x.id !== id));
    setSeenPairs(prev => {
      const copy = { ...prev };
      Object.keys(copy).forEach(k => {
        const [a, b] = k.split("::");
        if (a === id || b === id) delete copy[k];
      });
      return copy;
    });
    // Update tournament state
    setTState(prev => {
      if (!prev) return prev;
      const newActive = (prev.activeIds || []).filter(x => x !== id);
      const newElim = (prev.eliminatedIds || []).filter(x => x !== id);
      const newQueue = (prev.matchQueue || []).filter(([a, b]) => a !== id && b !== id);
      const newChampion = prev.championId === id ? null : prev.championId;
      return { ...prev, activeIds: newActive, eliminatedIds: newElim, matchQueue: newQueue, championId: newChampion };
    });
    setCurrentPair(null);
  }

  // Tournament controls
  function startTournament() {
    if (items.length < 2) {
      alert("Add at least two images to start the tournament.");
      return;
    }
    const seedOrder = shuffle(items.map(i => i.id));
    // Reset stats for fairness
    setItems(prev => prev.map(x => ({ ...x, wins: 0, losses: 0, comparisons: 0 })));
    const initialPairs = [];
    for (let i = 0; i < seedOrder.length - 1; i += 2) {
      initialPairs.push([seedOrder[i], seedOrder[i + 1]]);
    }
    // If odd, last gets bye (no pair this round)
    const activeIds = [...seedOrder];
    setTState({
      mode: "triple-elimination",
      seed: seedOrder,
      activeIds,
      eliminatedIds: [],
      matchQueue: initialPairs,
      currentRound: 1,
      championId: null,
    });
    // currentPair will be computed by effect
    setCurrentPair(null);
  }

  function resetTournament() {
    if (!tState) return;
    if (!window.confirm("Reset the tournament? Progress will be lost.")) return;
    setTState(null);
    setCurrentPair(null);
  }

  // export / import
  function exportData() {
    const payload = {
      version: 1,
      items,
      seenPairs,
      tournament: tState,
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
          setTState(parsed.tournament ?? null);
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
            {items.length >= 2 && !tState && (
              <button className="px-3 py-2 rounded-xl bg-emerald-600 text-white text-sm shadow" onClick={startTournament}>Start Triple Elimination</button>
            )}
            {tState && (
              <button className="px-3 py-2 rounded-xl bg-white border text-sm shadow-sm" onClick={resetTournament}>Reset Tournament</button>
            )}
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
                {!tState && (
                  <>
                    <div className="text-sm text-slate-600">Progress</div>
                    <div className="w-64 h-2 bg-slate-200 rounded-full overflow-hidden">
                      <div className="h-full bg-slate-900" style={{ width: `${progress}%` }} />
                    </div>
                    <div className="text-xs text-slate-500 mt-1">{Object.keys(seenPairs).length} / {totalUniquePairs} unique pairs • {progress}%</div>
                  </>
                )}
                {tState && (
                  <div className="text-sm text-slate-700">
                    <div className="font-medium">Triple Elimination Tournament</div>
                    <div className="text-xs text-slate-500">Round {tState.currentRound || 1} • Remaining: {(tState.activeIds || []).length} • Eliminated: {(tState.eliminatedIds || []).length}</div>
                    {tState.championId && (
                      <div className="mt-1 text-emerald-700 font-semibold">Champion decided! You can reset the tournament to start over.</div>
                    )}
                  </div>
                )}
              </div>
              <div className="flex gap-2 items-center">
                <button className="px-3 py-2 rounded-xl bg-white border text-sm shadow-sm disabled:opacity-50" disabled={history.length === 0 || !!tState} onClick={undo}>Undo</button>
                {!tState && (
                  <button className="px-3 py-2 rounded-xl bg-white border text-sm shadow-sm" onClick={() => setCurrentPair(getNextPair())}>Skip</button>
                )}
                <div className={`px-2 py-1 rounded-lg text-xs border ${deleteArmed ? 'bg-rose-50 text-rose-700 border-rose-300' : 'bg-white text-slate-600'}`}
                     title="Press Delete to arm, then Left/Right to delete that side. Esc to cancel.">
                  {deleteArmed ? 'Delete armed: Left/Right will delete' : 'Press Delete to arm deletion'}
                </div>
              </div>
            </div>

            {tState && tState.championId && (
              <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl mb-4 flex items-center gap-4">
                <div className="text-2xl">🏆</div>
                <div className="flex items-center gap-3">
                  <div className="w-20 h-20 rounded-xl overflow-hidden border bg-white">
                    <img src={items.find(i => i.id === tState.championId)?.dataUrl} alt="Champion" className="w-full h-full object-cover" />
                  </div>
                  <div>
                    <div className="font-semibold">Champion</div>
                    <div className="text-xs text-slate-600">{items.find(i => i.id === tState.championId)?.name}</div>
                  </div>
                </div>
              </div>
            )}

            {currentPair && (
              <div className={`grid grid-cols-1 md:grid-cols-2 gap-4 ${deleteArmed ? 'ring-2 ring-rose-300 rounded-xl p-1' : ''}`}>
                {[0, 1].map(idx => {
                  const img = currentPair[idx];
                  return (
                    <button
                      key={img.id}
                      className="group relative rounded-2xl overflow-hidden bg-white shadow border hover:shadow-md transition"
                      onClick={() => pickWinner(img.id)}
                    >
                      <div className="aspect-[4/3] w-full overflow-hidden bg-slate-100 relative">
                        <img src={img.dataUrl} alt={img.name} className={`h-full w-full object-contain transition ${deletingId === img.id ? 'opacity-30' : ''}`} />
                        {deletingId === img.id && (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <span className="px-3 py-2 rounded-lg bg-black/70 text-white text-sm font-semibold">Deleted</span>
                          </div>
                        )}
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
              <Gallery
                items={items}
                deletingId={deletingId}
                onRemove={(id) => {
                  // Show overlay then remove
                  if (deletionTimerRef.current) clearTimeout(deletionTimerRef.current);
                  setDeletingId(id);
                  deletionTimerRef.current = setTimeout(() => {
                    removeItem(id);
                    setDeletingId(null);
                    deletionTimerRef.current = null;
                  }, 550);
                }}
              />
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

function Gallery({ items, onRemove, deletingId }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {items.map(it => (
        <div key={it.id} className="group relative rounded-xl overflow-hidden border bg-slate-50">
          <div className="relative">
            <img src={it.dataUrl} alt={it.name} className={`w-full h-24 object-cover transition ${deletingId === it.id ? 'opacity-30' : ''}`} />
            {deletingId === it.id && (
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="px-2 py-1 rounded bg-black/70 text-white text-xs">Deleted</span>
              </div>
            )}
          </div>
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
