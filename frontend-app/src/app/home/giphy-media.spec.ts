import {describe, expect, it} from 'vitest';
import {parseGiphyMedia} from './giphy-media';

describe('parseGiphyMedia', () => {
    it('accepts documented direct GIF/WebP renditions and preserves queries', () => {
        expect(parseGiphyMedia('https://media1.giphy.com/media/cZ7rmKfFYOvYI/200.gif?x=1&y=2'))
            .toEqual({kind: 'image', source: 'https://media1.giphy.com/media/cZ7rmKfFYOvYI/200.gif?x=1&y=2'});
        expect(parseGiphyMedia('https://media1.giphy.com/media/cZ7rmKfFYOvYI/200.webp')?.kind).toBe('image');
    });

    it.each(['media0', 'media2', 'media3', 'media4'])('accepts fixed-height renditions from the %s CDN host', host => {
        const url = `https://${host}.giphy.com/media/cZ7rmKfFYOvYI/200.gif`;
        expect(parseGiphyMedia(url)).toEqual({kind: 'image', source: url});
    });

    it.each(['media0', 'media1', 'media2', 'media3', 'media4'])('accepts tokenized fixed-height results from the %s CDN host', host => {
        const url = `https://${host}.giphy.com/media/v1.c2FuaXRpemVkLXRva2Vu/approved42/200.gif`;
        expect(parseGiphyMedia(url)).toEqual({kind: 'image', source: url});
    });

    it.each(['media0', 'media1', 'media2', 'media3', 'media4'])('rejects ampersands in tokenized fixed-height paths on %s', host => {
        const url = `https://${host}.giphy.com/media/v1.token&ep=value/approved42/200.gif`;
        expect(parseGiphyMedia(url)).toBeNull();
    });

    it('accepts the direct media4 GIF URL rendition shared by GIPHY', () => {
        expect(parseGiphyMedia('https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjEx/abc123/giphy.gif'))
            .toEqual({kind: 'image', source: 'https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjEx/abc123/giphy.gif'});
        expect(parseGiphyMedia('https://media4.giphy.com/media/v1.Y2lkPTc5MGI3-NjEx/abc123/giphy.gif')?.kind).toBe('image');
    });

    it('accepts the direct media.giphy.com token GIF rendition', () => {
        expect(parseGiphyMedia('https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjEx/abc123/giphy.gif'))
            .toEqual({kind: 'image', source: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjEx/abc123/giphy.gif'});
    });

    it('accepts the media2 rendition URL copied from the GIPHY share page', () => {
        const rendition = 'https://media2.giphy.com/media/v1.Y2lkPTc5MGI3NjExcmNlZHQwd2hybXFhOTN6Y3hndms1Z2pyZjkzeGo2Z2libTFhbm9sNCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/gh6gFVh35jyzNvHegl/giphy.gif';
        expect(parseGiphyMedia(rendition)).toEqual({kind: 'image', source: rendition});
    });

    it('recognizes canonical share pages without converting or embedding them', () => {
        expect(parseGiphyMedia('https://giphy.com/gifs/dancing-cat-YsTs5ltWtEhnq?x=1'))
            .toEqual({kind: 'share-link', source: 'https://giphy.com/gifs/dancing-cat-YsTs5ltWtEhnq?x=1'});
    });

    it.each([
        'http://media1.giphy.com/media/id/200.gif', 'https://media1.giphy.com.evil.test/media/id/200.gif',
        'https://media0.giphy.com/media/v1.Y2lkPTc5MGI3NjEx/abc123/giphy.gif',
        'https://media3.giphy.com/media/v1.Y2lkPTc5MGI3NjEx/abc123/giphy.gif',
        'https://media2.giphy.com/media/v1.token/abc123/extra/giphy.gif',
        'https://media4.giphy.com/media/v1.token&ep=value/abc123/giphy.gif',
        'https://media.giphy.com/media/v1.token&ep=value/abc123/giphy.gif',
        'https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjEx/giphy.gif',
        'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjEx/giphy.gif',
        'https://media5.giphy.com/media/v1.c2FuaXRpemVkLXRva2Vu/approved42/200.gif',
        'https://media4.giphy.com/media/v1.c2FuaXRpemVkLXRva2Vu/approved42/200_d.gif',
        'https://media4.giphy.com/media/v1.c2FuaXRpemVkLXRva2Vu/approved42/200.mp4',
        'https://media4.giphy.com/media/v1.c2FuaXRpemVkLXRva2Vu%2Fapproved42/200.gif',
        'https://media4.giphy.com/media/id/unreviewed.gif', 'https://media4.giphy.com/media/id/unreviewed.webp',
        'https://media.giphy.com/media/id/200.gif', 'https://media.giphy.com.evil.test/media/v1.token/giphy.gif',
        'https://user@media1.giphy.com/media/id/200.gif', 'https://media1.giphy.com:443/media/id/200.gif',
        'https://media1.giphy.com/media/cZ7rmKfFYOvYI/unreviewed.gif', 'https://media1.giphy.com/media/cZ7rmKfFYOvYI/unreviewed.webp',
        'https://media1.giphy.com/media/cZ7rmKfFYOvYI/%32%30%30.gif', 'https://media1.giphy.com/media/cZ7rmKfFYOvYI/%2e%2e/200.gif',
        'https://media1.giphy.com/media/cZ7rmKfFYOvYI/extra/%2e%2e/200.gif',
        'https://media1.giphy.com/media/id/200.png', 'https://media1.giphy.com/media/id/200.mp4',
        'https://giphy.com/gifs/cat-id', 'https://giphy.com.evil.test/gifs/cat-abc123',
    ])('rejects unreviewed or deceptive URL %s', value => expect(parseGiphyMedia(value)).toBeNull());
});
