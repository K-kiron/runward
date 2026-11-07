import path from 'node:path';

function normalized(value) {
  if (typeof value !== 'string' || !value) return null;
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(value);
  const api = windows ? path.win32 : path.posix;
  if (!api.isAbsolute(value)) return null;
  const result = api.normalize(value).replaceAll('\\', '/').replace(/\/+$/, '') || '/';
  return { value: windows ? result.toLowerCase() : result, windows };
}

export function isCwdAllowed(cwd, roots) {
  const current = normalized(cwd);
  return !!current && roots.some(root => {
    const base = normalized(root);
    return base && current.windows === base.windows
      && (current.value === base.value || current.value.startsWith(base.value === '/' ? '/' : `${base.value}/`));
  });
}
