import {HTTP_INTERCEPTORS} from '@angular/common/http';
import {HttpClientTestingModule, HttpTestingController} from '@angular/common/http/testing';
import {TestBed} from '@angular/core/testing';
import {Router} from '@angular/router';
import {AuthInterceptorService, SKIP_AUTH_INTERCEPTOR} from '../auth/auth-interceptor.service';
import {AuthService} from '../auth/auth.service';
import {AuthCookieLockService} from '../auth/auth-cookie-lock.service';
import {HostService} from '../auth/host.service';
import {PwaService} from '../pwa/pwa.service';
import {GiphySearchService} from './giphy-search.service';

const KEY_URL = 'https://chat.localhost/api/auth/giphy-key';
const SEARCH_URL = 'https://api.giphy.com/v1/gifs/search';
const accessToken = (subject: string) => `header.${btoa(JSON.stringify({sub: subject}))}.signature`;
const GIF = {id: 'approved', title: 'Cat', rating: 'g', images: {fixed_height: {url: 'https://media1.giphy.com/media/cZ7rmKfFYOvYI/200.gif'}}};
const page = (data: unknown[], offset = 0, count = data.length, total_count = count) => ({data, meta: {pagination: {offset, count, total_count}}});

describe('GiphySearchService', () => {
    let service: GiphySearchService;
    let http: HttpTestingController;
    let auth: AuthService;
    let fetchMock: ReturnType<typeof vi.fn>;
    let now: number;

    beforeEach(() => {
        now = 1_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        fetchMock = vi.fn().mockImplementation(() => Promise.resolve(giphyResponse(page([]))));
        vi.stubGlobal('fetch', fetchMock);
        TestBed.configureTestingModule({
            imports: [HttpClientTestingModule],
            providers: [
                HostService,
                {provide: AuthCookieLockService, useValue: {run: (work: () => unknown) => work()}},
                {provide: HTTP_INTERCEPTORS, useClass: AuthInterceptorService, multi: true},
                {provide: PwaService, useValue: {confirmNetworkResponse: vi.fn()}},
                {provide: Router, useValue: {url: '/home', parseUrl: () => ({root: {children: {primary: {segments: [{path: 'home'}]}}}}), navigate: vi.fn()}},
            ],
        });
        auth = TestBed.inject(AuthService);
        auth.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: accessToken('first'), expires_in: 3600});
        service = TestBed.inject(GiphySearchService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => {
        http.verify();
        localStorage.removeItem('zwei.intended-session');
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    function giphyResponse(payload: unknown, status = 200): Response {
        return new Response(JSON.stringify(payload), {status});
    }

    function searchRequest(): {url: URL; options: RequestInit} {
        const [input, options] = fetchMock.mock.calls.at(-1) as [string | URL, RequestInit];
        return {url: new URL(input.toString()), options};
    }

    async function flushFetch(): Promise<void> {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
    }

    function grantKey(key = 'provider-key'): void {
        const request = http.expectOne(KEY_URL);
        expect(request.request.method).toBe('GET');
        expect(request.request.headers.get('Authorization')).toBe(`Bearer ${accessToken('first')}`);
        expect(request.request.context.get(SKIP_AUTH_INTERCEPTOR)).toBe(false);
        request.flush({api_key: key});
    }

    it('does not request a key until explicit search, then uses a G-rated no-credential no-referrer fetch', async () => {
        http.expectNone(KEY_URL);
        expect(fetchMock).not.toHaveBeenCalled();
        let results: unknown;
        fetchMock.mockResolvedValue(giphyResponse(page([GIF, {...GIF, id: 'wrong-rating', rating: 'pg'}])));
        service.search('cats').subscribe(value => results = value);
        grantKey();

        const {url, options} = searchRequest();
        expect(url.origin + url.pathname).toBe(SEARCH_URL);
        expect(url.searchParams.get('q')).toBe('cats');
        expect(url.searchParams.get('limit')).toBe('50');
        expect(url.searchParams.get('offset')).toBe('0');
        expect(url.searchParams.get('rating')).toBe('g');
        expect(url.searchParams.get('api_key')).toBe('provider-key');
        expect(options.credentials).toBe('omit');
        expect(options.referrerPolicy).toBe('no-referrer');
        expect(options.headers).toBeUndefined();
        await flushFetch();
        expect(results).toEqual({results: [{id: 'approved', title: 'Cat', url: GIF.images.fixed_height.url}], offset: 0, count: 2, totalCount: 2, hasMore: false});
    });

    it('requests metadata-based pages at the requested offset and limits the provider offset', async () => {
        let result: unknown;
        fetchMock.mockResolvedValue(giphyResponse(page([GIF], 50, 1, 100)));
        service.search('cats', 50).subscribe(value => result = value);
        grantKey();
        expect(searchRequest().url.searchParams.get('offset')).toBe('50');
        expect(searchRequest().url.searchParams.get('limit')).toBe('50');
        await flushFetch();
        expect(result).toEqual({results: [{id: 'approved', title: 'Cat', url: GIF.images.fixed_height.url}], offset: 50, count: 1, totalCount: 100, hasMore: true});
        let offsetFailure = '';
        service.search('cats', 5000).subscribe({error: error => offsetFailure = error.message});
        expect(offsetFailure).toBe('GIPHY search offset is out of range.');
    });

    it('maps GIPHY responses with pagination at the top level', async () => {
        let result: unknown;
        fetchMock.mockResolvedValue(giphyResponse({
            data: [GIF],
            pagination: {offset: 0, count: 1, total_count: 3},
            meta: {status: 200, msg: 'OK'},
        }));
        service.search('cats').subscribe(value => result = value);
        grantKey();
        await flushFetch();
        expect(result).toEqual({results: [{id: 'approved', title: 'Cat', url: GIF.images.fixed_height.url}], offset: 0, count: 1, totalCount: 3, hasMore: true});
    });

    it('uses provider pagination count rather than the filtered result count to detect the end', async () => {
        let result: unknown;
        fetchMock.mockResolvedValue(giphyResponse(page([{...GIF, rating: 'pg'}], 50, 1, 60)));
        service.search('cats', 50).subscribe(value => result = value);
        grantKey();
        await flushFetch();
        expect(result).toEqual({results: [], offset: 50, count: 1, totalCount: 60, hasMore: true});
    });

    it.each([
        {offset: 1, count: 1, total_count: 2},
        {offset: 0, count: -1, total_count: 2},
        {offset: 0, count: 51, total_count: 51},
        {offset: 0, count: 2, total_count: 1},
    ])('rejects invalid pagination metadata $offset/$count/$total_count', async pagination => {
        let failure = '';
        fetchMock.mockResolvedValue(giphyResponse({data: [GIF], meta: {pagination}}));
        service.search('cats').subscribe({error: error => failure = error.message});
        grantKey(); await flushFetch();
        expect(failure).toBe('GIPHY returned an invalid search response.');
    });

    it('maps a G-rated fixed-height result served from the media3 CDN host', async () => {
        let results: unknown;
        fetchMock.mockResolvedValue(giphyResponse(page([{...GIF, images: {fixed_height: {url: 'https://media3.giphy.com/media/cZ7rmKfFYOvYI/200.gif'}}}])));
        service.search('tell me more').subscribe(value => results = value);
        grantKey();
        await flushFetch();
        expect(results).toMatchObject({results: [{id: 'approved', title: 'Cat', url: 'https://media3.giphy.com/media/cZ7rmKfFYOvYI/200.gif'}]});
    });

    it('maps a G-rated tokenized fixed-height result returned by live GIPHY search', async () => {
        const url = 'https://media4.giphy.com/media/v1.c2FuaXRpemVkLXRva2Vu/approved42/200.gif';
        let results: unknown;
        fetchMock.mockResolvedValue(giphyResponse(page([{...GIF, images: {fixed_height: {url}}}])));
        service.search('amazing day').subscribe(value => results = value);
        grantKey();
        await flushFetch();
        expect(results).toMatchObject({results: [{id: 'approved', title: 'Cat', url}]});
    });

    it('shares one first key request across concurrent searches', async () => {
        const results: unknown[] = [];
        fetchMock.mockImplementation(() => Promise.resolve(giphyResponse(page([]))));
        service.search('cats').subscribe(value => results.push(value));
        service.search('dogs').subscribe(value => results.push(value));
        grantKey();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await flushFetch();
        expect(results).toEqual([{results: [], offset: 0, count: 0, totalCount: 0, hasMore: false}, {results: [], offset: 0, count: 0, totalCount: 0, hasMore: false}]);
    });

    it('expires exactly 15 minutes after grant and does not extend the TTL when the key is reused', async () => {
        service.search('first').subscribe();
        grantKey('first-key');
        await flushFetch();

        now += 14 * 60 * 1000;
        service.search('reuse').subscribe();
        await flushFetch();
        now += 60 * 1000;
        service.search('expired').subscribe();
        grantKey('refreshed-key');
        expect(searchRequest().url.searchParams.get('api_key')).toBe('refreshed-key');
        await flushFetch();
    });

    it('does not use an expired key after a failed refresh, and retries on the next explicit search', async () => {
        service.search('first').subscribe();
        grantKey('old-key');
        await flushFetch();
        now += 15 * 60 * 1000;

        let failed = false;
        service.search('expired').subscribe({error: () => failed = true});
        http.expectOne(KEY_URL).flush({error: 'unavailable'}, {status: 503, statusText: 'Unavailable'});
        expect(failed).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        service.search('retry').subscribe();
        grantKey('new-key');
        expect(searchRequest().url.searchParams.get('api_key')).toBe('new-key');
        await flushFetch();
    });

    it('clears a cached grant when the authenticated token changes', async () => {
        service.search('first').subscribe();
        grantKey();
        await flushFetch();
        auth.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: accessToken('replacement'), expires_in: 3600});
        service.search('after-change').subscribe();
        const request = http.expectOne(KEY_URL);
        expect(request.request.headers.get('Authorization')).toBe(`Bearer ${accessToken('replacement')}`);
        request.flush({api_key: 'replacement-key'});
        expect(searchRequest().url.searchParams.get('api_key')).toBe('replacement-key');
        await flushFetch();
    });

    it('fences a grant that arrives after logout and fetches a fresh grant for the next authorized search', () => {
        let staleError = '';
        let staleSearchCompleted = false;
        service.search('before-logout').subscribe({
            error: error => staleError = error.message,
            complete: () => staleSearchCompleted = true,
        });
        const pendingGrant = http.expectOne(KEY_URL);

        auth.logout(false).subscribe();
        pendingGrant.flush({api_key: 'late-key'});
        expect(fetchMock).not.toHaveBeenCalled();
        expect(staleError).toBe('GIPHY search was interrupted. Try again.');
        expect(staleSearchCompleted).toBe(false);

        auth.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: accessToken('new-account'), expires_in: 3600});
        service.search('after-login').subscribe();
        const freshGrant = http.expectOne(KEY_URL);
        expect(freshGrant.request.headers.get('Authorization')).toBe(`Bearer ${accessToken('new-account')}`);
        freshGrant.flush({api_key: 'new-account-key'});
        expect(searchRequest().url.searchParams.get('api_key')).toBe('new-account-key');
    });

    it('cancels an in-flight grant when every search subscriber unsubscribes', () => {
        const subscription = service.search('abandoned').subscribe();
        const abandonedGrant = http.expectOne(KEY_URL);
        subscription.unsubscribe();
        expect(abandonedGrant.cancelled).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();

        service.search('new-search').subscribe();
        grantKey('fresh-key');
        expect(searchRequest().url.searchParams.get('api_key')).toBe('fresh-key');
    });

    it('times out a hung key grant, cancels it, and obtains a fresh grant on retry', () => {
        vi.useFakeTimers();
        try {
            let failure = '';
            const timedOutSearch = service.search('stalled grant').subscribe({error: error => failure = error.message});
            const stalledGrant = http.expectOne(KEY_URL);

            vi.advanceTimersByTime(15_000);

            expect(failure).toBe('GIPHY search failed. Try again.');
            expect(stalledGrant.cancelled).toBe(true);
            expect(fetchMock).not.toHaveBeenCalled();
            timedOutSearch.unsubscribe();

            const retry = service.search('retry grant').subscribe();
            const freshGrant = http.expectOne(KEY_URL);
            expect(freshGrant.cancelled).toBe(false);
            freshGrant.flush({api_key: 'fresh-key'});
            expect(searchRequest().url.searchParams.get('api_key')).toBe('fresh-key');
            retry.unsubscribe();
        } finally { vi.useRealTimers(); }
    });

    it('aborts the provider fetch and its active response body when the search is cancelled', async () => {
        let bodyStarted = false;
        let bodyAborted = false;
        fetchMock.mockImplementation((_input: string | URL, options: RequestInit) => Promise.resolve({
            ok: true,
            status: 200,
            body: new ReadableStream<Uint8Array>({
                pull(controller) {
                    bodyStarted = true;
                    options.signal?.addEventListener('abort', () => {
                        bodyAborted = true;
                        controller.error(new Error('aborted'));
                    }, {once: true});
                    return new Promise<void>(() => undefined);
                },
            }),
        } as Response));
        let requestFailure = '';
        const subscription = service.search('cancel provider request').subscribe({error: error => requestFailure = error.message});
        grantKey();
        await flushFetch();
        const signal = searchRequest().options.signal;
        expect(bodyStarted).toBe(true);
        expect(signal?.aborted).toBe(false);
        subscription.unsubscribe();
        expect(signal?.aborted).toBe(true);
        expect(bodyAborted).toBe(true);
        expect(requestFailure).toBe('');
    });

    it('rejects an oversized streamed provider body before consuming the remaining chunks', async () => {
        const chunksRead: number[] = [];
        let bodyCancelled = false;
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            body: new ReadableStream<Uint8Array>({
                pull(controller) {
                    chunksRead.push(chunksRead.length);
                    controller.enqueue(new Uint8Array(256 * 1024));
                    if (chunksRead.length === 10) controller.close();
                },
                cancel() { bodyCancelled = true; },
            }),
        } as Response);
        let failure = '';
        service.search('large response').subscribe({error: error => failure = error.message});
        grantKey();
        await flushFetch();

        expect(failure).toBe('GIPHY search failed. Try again.');
        expect(chunksRead.length).toBeLessThan(10);
        expect(bodyCancelled).toBe(true);
    });

    it('times out a stalled response body and aborts the provider request', async () => {
        vi.useFakeTimers();
        try {
            let readerController: ReadableStreamDefaultController<Uint8Array> | undefined;
            fetchMock.mockResolvedValue({
                ok: true,
                status: 200,
                body: new ReadableStream<Uint8Array>({start(controller) { readerController = controller; }}),
            } as Response);
            let failure = '';
            service.search('stalled response').subscribe({error: error => failure = error.message});
            grantKey();
            const signal = searchRequest().options.signal;
            await vi.advanceTimersByTimeAsync(15_000);

            expect(failure).toBe('GIPHY search failed. Try again.');
            expect(signal?.aborted).toBe(true);
            readerController?.error(new Error('discarded'));
        } finally { vi.useRealTimers(); }
    });

    it('rejects a non-success provider response without emitting results', async () => {
        let errorMessage = '';
        let emittedResults = false;
        fetchMock.mockResolvedValue(giphyResponse({message: 'quota exceeded'}, 429));
        service.search('cats').subscribe({next: () => emittedResults = true, error: error => errorMessage = error.message});
        grantKey();
        await flushFetch();
        expect(errorMessage).toBe('GIPHY search failed. Try again.');
        expect(emittedResults).toBe(false);
    });

    it('rejects invalid queries before requesting a key and preserves result validation', async () => {
        let errorMessage = '';
        service.search('x'.repeat(51)).subscribe({error: error => errorMessage = error.message});
        expect(errorMessage).toBe('Enter a search term of 1 to 50 characters.');
        http.expectNone(KEY_URL);

        fetchMock.mockResolvedValue(giphyResponse(page([{id: 'malformed'}])));
        service.search('broken').subscribe({error: error => errorMessage = error.message});
        grantKey();
        await flushFetch();
        expect(errorMessage).toBe('GIPHY returned an invalid search response.');
    });
});
