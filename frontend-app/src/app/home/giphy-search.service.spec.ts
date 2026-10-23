import {HTTP_INTERCEPTORS} from '@angular/common/http';
import {HttpClientTestingModule, HttpTestingController} from '@angular/common/http/testing';
import {TestBed} from '@angular/core/testing';
import {Router} from '@angular/router';
import {AuthInterceptorService, SKIP_AUTH_INTERCEPTOR} from '../auth/auth-interceptor.service';
import {AuthService} from '../auth/auth.service';
import {HostService} from '../auth/host.service';
import {PwaService} from '../pwa/pwa.service';
import {GiphySearchService} from './giphy-search.service';

const KEY_URL = 'https://chat.localhost/api/auth/giphy-key';
const SEARCH_URL = 'https://api.giphy.com/v1/gifs/search';
const GIF = {id: 'approved', title: 'Cat', rating: 'g', images: {fixed_height: {url: 'https://media1.giphy.com/media/cZ7rmKfFYOvYI/200.gif'}}};
const isSearchRequest = (request: {url: string}): boolean => request.url === SEARCH_URL;

describe('GiphySearchService', () => {
    let service: GiphySearchService;
    let http: HttpTestingController;
    let auth: AuthService;
    let now: number;

    beforeEach(() => {
        now = 1_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        TestBed.configureTestingModule({
            imports: [HttpClientTestingModule],
            providers: [
                HostService,
                {provide: HTTP_INTERCEPTORS, useClass: AuthInterceptorService, multi: true},
                {provide: PwaService, useValue: {confirmNetworkResponse: vi.fn()}},
                {provide: Router, useValue: {url: '/home', parseUrl: () => ({root: {children: {primary: {segments: [{path: 'home'}]}}}}), navigate: vi.fn()}},
            ],
        });
        auth = TestBed.inject(AuthService);
        auth.acceptToken({token_type: 'Bearer', access_token: 'test-access-token', expires_in: 3600});
        service = TestBed.inject(GiphySearchService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => {
        http.verify();
        vi.restoreAllMocks();
    });

    function grantKey(key = 'provider-key'): void {
        const request = http.expectOne(KEY_URL);
        expect(request.request.method).toBe('GET');
        expect(request.request.headers.get('Authorization')).toBe('Bearer test-access-token');
        expect(request.request.context.get(SKIP_AUTH_INTERCEPTOR)).toBe(false);
        request.flush({api_key: key});
    }

    it('does not request a key until an explicit search, then makes the direct G-rated request without credentials or referrer', () => {
        http.expectNone(KEY_URL);
        http.expectNone(isSearchRequest);
        let results: unknown;
        service.search('cats').subscribe(value => results = value);
        grantKey();

        const request = http.expectOne(isSearchRequest);
        expect(request.request.params.get('q')).toBe('cats');
        expect(request.request.params.get('limit')).toBe('50');
        expect(request.request.params.get('rating')).toBe('g');
        expect(request.request.params.get('api_key')).toBe('provider-key');
        expect(request.request.withCredentials).toBe(false);
        expect(request.request.referrerPolicy).toBe('no-referrer');
        expect(request.request.headers.has('Authorization')).toBe(false);
        request.flush({data: [GIF, {...GIF, id: 'wrong-rating', rating: 'pg'}]});
        expect(results).toEqual([{id: 'approved', title: 'Cat', url: GIF.images.fixed_height.url}]);
    });

    it('maps a G-rated fixed-height result served from the media3 CDN host', () => {
        let results: unknown;
        service.search('tell me more').subscribe(value => results = value);
        grantKey();
        const request = http.expectOne(isSearchRequest);
        request.flush({data: [{...GIF, images: {fixed_height: {url: 'https://media3.giphy.com/media/cZ7rmKfFYOvYI/200.gif'}}}]});
        expect(results).toEqual([{id: 'approved', title: 'Cat', url: 'https://media3.giphy.com/media/cZ7rmKfFYOvYI/200.gif'}]);
    });

    it('shares one first key request across concurrent searches', () => {
        const results: unknown[] = [];
        service.search('cats').subscribe(value => results.push(value));
        service.search('dogs').subscribe(value => results.push(value));
        grantKey();
        const searches = http.match(isSearchRequest);
        expect(searches).toHaveLength(2);
        searches.forEach(request => request.flush({data: []}));
        expect(results).toEqual([[], []]);
    });

    it('expires exactly 15 minutes after grant and does not extend the TTL when the key is reused', () => {
        service.search('first').subscribe();
        grantKey('first-key');
        http.expectOne(isSearchRequest).flush({data: []});

        now += 14 * 60 * 1000;
        service.search('reuse').subscribe();
        http.expectOne(isSearchRequest).flush({data: []});
        now += 60 * 1000;
        service.search('expired').subscribe();
        grantKey('refreshed-key');
        expect(http.expectOne(isSearchRequest).request.params.get('api_key')).toBe('refreshed-key');
        http.match(isSearchRequest).forEach(request => request.flush({data: []}));
    });

    it('does not use an expired key after a failed refresh, and retries on the next explicit search', () => {
        service.search('first').subscribe();
        grantKey('old-key');
        http.expectOne(isSearchRequest).flush({data: []});
        now += 15 * 60 * 1000;

        let failed = false;
        service.search('expired').subscribe({error: () => failed = true});
        http.expectOne(KEY_URL).flush({error: 'unavailable'}, {status: 503, statusText: 'Unavailable'});
        expect(failed).toBe(true);
        http.expectNone(isSearchRequest);

        service.search('retry').subscribe();
        grantKey('new-key');
        expect(http.expectOne(isSearchRequest).request.params.get('api_key')).toBe('new-key');
        http.match(isSearchRequest).forEach(request => request.flush({data: []}));
    });

    it('clears a cached grant when the authenticated token changes', () => {
        service.search('first').subscribe();
        grantKey();
        http.expectOne(isSearchRequest).flush({data: []});
        auth.acceptToken({token_type: 'Bearer', access_token: 'replacement-token', expires_in: 3600});
        service.search('after-change').subscribe();
        const request = http.expectOne(KEY_URL);
        expect(request.request.headers.get('Authorization')).toBe('Bearer replacement-token');
        request.flush({api_key: 'replacement-key'});
        expect(http.expectOne(isSearchRequest).request.params.get('api_key')).toBe('replacement-key');
        http.match(isSearchRequest).forEach(search => search.flush({data: []}));
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
        const staleSearches = http.match(isSearchRequest);
        staleSearches.forEach(request => request.flush({data: []}));
        expect(staleSearches).toHaveLength(0);
        expect(staleError).toBe('GIPHY search was interrupted. Try again.');
        expect(staleSearchCompleted).toBe(false);

        auth.acceptToken({token_type: 'Bearer', access_token: 'new-account-token', expires_in: 3600});
        service.search('after-login').subscribe();
        const freshGrant = http.expectOne(KEY_URL);
        expect(freshGrant.request.headers.get('Authorization')).toBe('Bearer new-account-token');
        freshGrant.flush({api_key: 'new-account-key'});
        expect(http.expectOne(isSearchRequest).request.params.get('api_key')).toBe('new-account-key');
        http.match(isSearchRequest).forEach(request => request.flush({data: []}));
    });

    it('cancels an in-flight grant when every search subscriber unsubscribes', () => {
        const subscription = service.search('abandoned').subscribe();
        const abandonedGrant = http.expectOne(KEY_URL);
        subscription.unsubscribe();
        expect(abandonedGrant.cancelled).toBe(true);

        service.search('new-search').subscribe();
        grantKey('fresh-key');
        expect(http.expectOne(isSearchRequest).request.params.get('api_key')).toBe('fresh-key');
        http.match(isSearchRequest).forEach(request => request.flush({data: []}));
    });

    it('rejects invalid queries before requesting a key and preserves result validation', () => {
        let errorMessage = '';
        service.search('x'.repeat(51)).subscribe({error: error => errorMessage = error.message});
        expect(errorMessage).toBe('Enter a search term of 1 to 50 characters.');
        http.expectNone(KEY_URL);

        service.search('broken').subscribe({error: error => errorMessage = error.message});
        grantKey();
        http.expectOne(isSearchRequest).flush({data: [{id: 'malformed'}]});
        expect(errorMessage).toBe('GIPHY returned an invalid search response.');
    });
});
