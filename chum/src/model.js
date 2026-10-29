export const DAY = 86400000;
export const alive = (link, now = Date.now()) => !!link && !link.revoked && link.expires > now;

// Presentation helpers only. The backend authorizes every operation.
export function within(items, id, root) {
  if (root === 'root' || id === root) return true;
  const seen = new Set();
  while (id && !seen.has(id)) {
    seen.add(id);
    const item = items.find(x => x.id === id);
    if (!item) return false;
    if (item.parent === root) return true;
    id = item.parent;
  }
  return false;
}
export const canDelete = (item, user, items) => user.role === 'admin' || (item.owner === user.id && (item.kind !== 'folder' || !items.some(x => x.parent === item.id)));

// The dev proxy accepts the backend's default sharing domain, but links should
// return to the frontend. Public production domains are always kept as configured.
export function sharingOrigin(configured, current, backend, development = false) {
  if (development && configured === backend) return current;
  return (configured || current).replace(/\/$/, '');
}
