import {HttpClient, HttpContext, HttpParams} from '@angular/common/http';
import {Injectable} from '@angular/core';
import {distinctUntilChanged, finalize, map, Observable, of, shareReplay, switchMap, tap, throwError} from 'rxjs';
import {parseGiphyMedia} from './giphy-media';
import {SKIP_AUTH_INTERCEPTOR} from '../auth/auth-interceptor.service';
import {HostService} from '../auth/host.service';
import {AuthService} from '../auth/auth.service';

const GIPHY_KEY_TTL_MS = 15 * 60 * 1000;

export interface GiphySearchResult {
    id: string;
    title: string;
    url: string;
}

@Injectable({providedIn: 'root'})
export class GiphySearchService {
    private cachedKey?: string;
    private keyExpiresAt = 0;
    private keyRequest?: Observable<string>;
    private tokenGeneration = 0;

    constructor(private readonly http: HttpClient, private readonly host: HostService, auth: AuthService) {
        auth.token.pipe(
            map(token => token ? `${token.token_type} ${token.access_token}` : null),
            distinctUntilChanged(),
        ).subscribe(() => {
            this.tokenGeneration++;
            this.cachedKey = undefined;
            this.keyExpiresAt = 0;
            this.keyRequest = undefined;
        });
    }

    public search(query: string): Observable<GiphySearchResult[]> {
        const term = query.trim();
        if (!term || term.length > 50) return throwError(() => new Error('Enter a search term of 1 to 50 characters.'));
        return this.getKey().pipe(switchMap(key => {
            const params = new HttpParams().set('api_key', key).set('q', term).set('limit', '50').set('rating', 'g');
            return this.http.get<unknown>('https://api.giphy.com/v1/gifs/search', {params, withCredentials: false, referrerPolicy: 'no-referrer', context: new HttpContext().set(SKIP_AUTH_INTERCEPTOR, true)}).pipe(
                map(payload => mapGiphySearchResponse(payload)),
            );
        }));
    }

    private getKey(): Observable<string> {
        if (this.cachedKey && Date.now() < this.keyExpiresAt) return of(this.cachedKey);
        if (this.keyRequest) return this.keyRequest;

        const generation = this.tokenGeneration;
        this.keyRequest = this.http.get<unknown>(this.host.authEndpoint('giphy-key')).pipe(
            map(readGiphyKey),
            map(key => {
                if (generation !== this.tokenGeneration) throw new Error('GIPHY search was interrupted. Try again.');
                return key;
            }),
            tap(key => {
                this.cachedKey = key;
                this.keyExpiresAt = Date.now() + GIPHY_KEY_TTL_MS;
            }),
            finalize(() => { if (this.keyRequest === request) this.keyRequest = undefined; }),
            shareReplay({bufferSize: 1, refCount: true}),
        );
        const request = this.keyRequest;
        return request;
    }
}

function readGiphyKey(payload: unknown): string {
    if (typeof payload !== 'object' || payload === null || !('api_key' in payload) || typeof payload.api_key !== 'string' || !payload.api_key.trim()) {
        throw new Error('GIPHY search is unavailable.');
    }
    return payload.api_key.trim();
}

function mapGiphySearchResponse(payload: unknown): GiphySearchResult[] {
    if (!payload || typeof payload !== 'object' || !('data' in payload) || !Array.isArray(payload.data)) throw new Error('GIPHY returned an invalid search response.');
    const items: unknown[] = payload.data;
    const results: GiphySearchResult[] = [];
    for (const item of items.slice(0, 50)) {
        if (!isRecord(item) || !isRecord(item.images)) throw new Error('GIPHY returned an invalid search response.');
        const {id, title, rating} = item;
        if (typeof id !== 'string' || !id || typeof title !== 'string' || typeof rating !== 'string') throw new Error('GIPHY returned an invalid search response.');
        if (!('fixed_height' in item.images)) continue;
        if (!isRecord(item.images.fixed_height) || typeof item.images.fixed_height.url !== 'string') throw new Error('GIPHY returned an invalid search response.');
        const url = item.images.fixed_height.url;
        if (rating !== 'g') continue;
        const media = parseGiphyMedia(url);
        if (media?.kind === 'image') results.push({id, title: title.slice(0, 200), url: media.source});
    }
    return results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
