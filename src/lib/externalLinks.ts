export function openExternalUrl(url: string): void {
  if (!url) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function openExternalLinkHandler(url: string) {
  return (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    openExternalUrl(url);
  };
}
