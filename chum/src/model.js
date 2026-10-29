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
export const canFreezeOrThaw = (item, user) => item.kind === 'file' && (!item.frozen || user.role === 'admin' || item.frozen_by === user.id);

const mediaExtensions = { image: ['jpg','jpeg','png','gif','webp','avif','bmp'], audio: ['mp3','m4a','ogg','oga','wav','flac'], video: ['mp4','webm','ogv','mov'], pdf: ['pdf'] };
export function mediaKind(item) {
  if (item.kind !== 'file' || !item.name.includes('.')) return null;
  const ext = item.name.split('.').pop().toLowerCase();
  return Object.keys(mediaExtensions).find(kind => mediaExtensions[kind].includes(ext)) || null;
}
export function folderPlaylist(items, item) {
  const kind = mediaKind(item);
  return items.filter(candidate => candidate.parent === item.parent && mediaKind(candidate) === kind).sort((a,b) => a.name.localeCompare(b.name));
}

// The dev proxy accepts the backend's default sharing domain, but links should
// return to the frontend. Public production domains are always kept as configured.
export function sharingOrigin(configured, current, backend, development = false) {
  if (development && configured === backend) return current;
  return (configured || current).replace(/\/$/, '');
}
