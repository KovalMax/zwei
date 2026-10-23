export type GiphyMedia = {kind: 'image'; source: string} | {kind: 'share-link'; source: string};

/** Accept only documented GIPHY image CDN renditions and canonical GIF detail links. */
export function parseGiphyMedia(value: string): GiphyMedia | null {
    let url: URL;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
    const mediaHost = /^media(?:[0-4])?\.giphy\.com$/.test(url.hostname);
    const rawMediaPath = value.startsWith(`https://${url.hostname}/`) ? value.slice(`https://${url.hostname}`.length).split(/[?#]/, 1)[0] : '';
    const documentedRendition = /^media[0-4]\.giphy\.com$/.test(url.hostname)
        && /^\/media\/[A-Za-z0-9]+\/200\.(?:gif|webp)$/i.test(rawMediaPath);
    const sharedTokenCharacters = url.hostname === 'media2.giphy.com' ? '[A-Za-z0-9._=&-]+' : '[A-Za-z0-9._=-]+';
    const tokenizedFixedHeightRendition = /^media[0-4]\.giphy\.com$/.test(url.hostname)
        && /^\/media\/v1\.[A-Za-z0-9._=-]+\/[A-Za-z0-9_-]+\/200\.(?:gif|webp)$/i.test(rawMediaPath);
    const sharedDirectRendition = /^media(?:2|4)?\.giphy\.com$/.test(url.hostname)
        && new RegExp(`^/media/v1\\.${sharedTokenCharacters}/[A-Za-z0-9_-]+/giphy\\.gif$`, 'i').test(rawMediaPath);
    if (mediaHost && (documentedRendition || tokenizedFixedHeightRendition || sharedDirectRendition)) {
        return {kind: 'image', source: `https://${url.hostname}${url.pathname}${url.search}`};
    }
    if (url.hostname === 'giphy.com' && value.startsWith('https://giphy.com/')) {
        const match = url.pathname.match(/^\/gifs\/[A-Za-z0-9-]+-([A-Za-z0-9]{6,})$/);
        if (match) return {kind: 'share-link', source: value};
    }
    return null;
}
