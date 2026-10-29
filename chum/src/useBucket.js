import { useCallback, useEffect, useRef, useState } from 'react';
import { createChumbucketClient } from './chumbucket.js';

const api = createChumbucketClient();
const empty = { user: null, items: [], links: [], settings: null, rootFolder: null };

export function useBucket() {
  const [state, setState] = useState(empty);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const epoch = useRef(0), locked = useRef(false), alive = useRef(true);
  const refreshSequence = useRef(0);

  const clear = useCallback(() => {
    epoch.current++;
    refreshSequence.current++;
    setState(empty);
  }, []);

  const refresh = useCallback(async () => {
    const generation = epoch.current, sequence = ++refreshSequence.current;
    try {
      const { user } = await api.session();
      const [listing, invitations, configuration] = await Promise.all([
        api.list(user.root),
        user.role === 'admin' ? api.links() : Promise.resolve({ links: [] }),
        user.role === 'admin' ? api.settings() : Promise.resolve({ settings: null }),
      ]);
      if (alive.current && generation === epoch.current && sequence === refreshSequence.current) {
        setState({ user, items: listing.tree, rootFolder: listing.folder, links: invitations.links, settings: configuration.settings });
        setError('');
      }
    } catch (failure) {
      if (alive.current && generation === epoch.current && sequence === refreshSequence.current) {
        if (failure.status === 401) { clear(); setError(''); }
        else setError(failure.message);
      }
      throw failure;
    } finally {
      if (alive.current && generation === epoch.current) setLoading(false);
      // clear() advances the generation after an unauthenticated response.
      if (alive.current && sequence + 1 === refreshSequence.current) setLoading(false);
    }
  }, [clear]);

  useEffect(() => {
    alive.current = true;
    const poll = () => {
      if (!locked.current && document.visibilityState !== 'hidden') refresh().catch(() => {});
    };
    refresh().catch(() => {});
    const timer = setInterval(poll, 15000);
    window.addEventListener('focus', poll);
    document.addEventListener('visibilitychange', poll);
    return () => {
      alive.current = false;
      refreshSequence.current++;
      clearInterval(timer);
      window.removeEventListener('focus', poll);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [refresh]);

  async function login(passphrase) {
    if (locked.current) return false;
    locked.current = true; setBusy(true);
    epoch.current++; refreshSequence.current++;
    try { await api.login(passphrase); await refresh(); return true; }
    catch (failure) { throw failure; }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }

  async function logout() {
    if (locked.current) return;
    locked.current = true; setBusy(true);
    epoch.current++; refreshSequence.current++;
    try { await api.logout(); clear(); setError(''); }
    catch (failure) { if (failure.status === 401) clear(); else throw failure; }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }

  async function mutate(operation) {
    if (locked.current) throw new Error('Another change is still in progress. Please wait.');
    locked.current = true; setBusy(true);
    epoch.current++; refreshSequence.current++;
    try {
      const result = await operation(api);
      await refresh();
      return result;
    } catch (failure) {
      if (failure.status === 401) clear();
      else await refresh().catch(() => {});
      throw failure;
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }

  return { ...state, loading, busy, error, api, refresh, login, logout, mutate };
}
