import {describe, expect, it} from 'vitest';
import {parseGiphyMedia} from './giphy-media';

describe('parseGiphyMedia', () => {
    it('accepts documented direct GIF/WebP renditions and preserves queries', () => {
        expect(parseGiphyMedia('https://media1.giphy.com/media/cZ7rmKfFYOvYI/200.gif?x=1&y=2'))
            .toEqual({kind: 'image', source: 'https://media1.giphy.com/media/cZ7rmKfFYOvYI/200.gif?x=1&y=2'});
        expect(parseGiphyMedia('https://media1.giphy.com/media/cZ7rmKfFYOvYI/200.webp')?.kind).toBe('image');
    });

    it('recognizes canonical share pages without converting or embedding them', () => {
        expect(parseGiphyMedia('https://giphy.com/gifs/dancing-cat-YsTs5ltWtEhnq?x=1'))
            .toEqual({kind: 'share-link', source: 'https://giphy.com/gifs/dancing-cat-YsTs5ltWtEhnq?x=1'});
    });

    it.each([
        'http://media1.giphy.com/media/id/200.gif', 'https://media1.giphy.com.evil.test/media/id/200.gif',
        'https://user@media1.giphy.com/media/id/200.gif', 'https://media1.giphy.com:443/media/id/200.gif',
        'https://media1.giphy.com/media/cZ7rmKfFYOvYI/unreviewed.gif', 'https://media1.giphy.com/media/cZ7rmKfFYOvYI/unreviewed.webp',
        'https://media1.giphy.com/media/cZ7rmKfFYOvYI/%32%30%30.gif', 'https://media1.giphy.com/media/cZ7rmKfFYOvYI/%2e%2e/200.gif',
        'https://media1.giphy.com/media/cZ7rmKfFYOvYI/extra/%2e%2e/200.gif',
        'https://media1.giphy.com/media/id/200.png', 'https://media1.giphy.com/media/id/200.mp4',
        'https://giphy.com/gifs/cat-id', 'https://giphy.com.evil.test/gifs/cat-abc123',
    ])('rejects unreviewed or deceptive URL %s', value => expect(parseGiphyMedia(value)).toBeNull());
});
