export type GiphyMedia = {kind: 'image'; source: string} | {kind: 'share-link'; source: string};

/** Accept only documented GIPHY image CDN renditions and canonical GIF detail links. */
export function parseGiphyMedia(value: string): GiphyMedia | null {
    let url: URL;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
    const mediaPrefix = 'https://media1.giphy.com';
    const rawMediaPath = value.startsWith(`${mediaPrefix}/`) ? value.slice(mediaPrefix.length).split(/[?#]/, 1)[0] : '';
    if (url.hostname === 'media1.giphy.com' && /^\/media\/[A-Za-z0-9]+\/200\.(?:gif|webp)$/i.test(rawMediaPath)) {
        return {kind: 'image', source: `https://media1.giphy.com${url.pathname}${url.search}`};
    }
    if (url.hostname === 'giphy.com' && value.startsWith('https://giphy.com/')) {
        const match = url.pathname.match(/^\/gifs\/[A-Za-z0-9-]+-([A-Za-z0-9]{6,})$/);
        if (match) return {kind: 'share-link', source: value};
    }
    return null;
}
