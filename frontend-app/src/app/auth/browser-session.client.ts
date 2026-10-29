import {HttpClient, HttpContext} from '@angular/common/http';
import {Injectable} from '@angular/core';
import {Observable} from 'rxjs';
import {AuthCookieLockService} from './auth-cookie-lock.service';
import {Token} from './token';
import {SKIP_AUTH_INTERCEPTOR} from './auth-interceptor.service';

/** Deployment supplies these URLs only when the v2 protocol is enabled. */
export interface BrowserSessionEndpoints {
    discover: string;
    continue: string;
}

export interface BrowserSessionSelector {
    browser_id: string;
    generation: string;
}

export interface BrowserSessionCandidate extends BrowserSessionSelector {
    display_name: string;
}

export interface ContinuedBrowserSession extends BrowserSessionSelector, Token {}

/** Transport only: discovery is not an authorization and never rotates a cookie. */
@Injectable({providedIn: 'root'})
export class BrowserSessionClient {
    constructor(private http: HttpClient, private cookieLock: AuthCookieLockService) {}

    discover(endpoints: BrowserSessionEndpoints): Observable<{candidates: BrowserSessionCandidate[]}> {
        return this.http.post<{candidates: BrowserSessionCandidate[]}>(endpoints.discover, {}, {withCredentials: true, context: new HttpContext().set(SKIP_AUTH_INTERCEPTOR, true)});
    }

    continue(endpoints: BrowserSessionEndpoints, selector: BrowserSessionSelector): Observable<ContinuedBrowserSession> {
        const request = {browser_id: selector.browser_id, generation: selector.generation};
        return this.cookieLock.run(() => this.http.post<ContinuedBrowserSession>(endpoints.continue, request, {withCredentials: true, context: new HttpContext().set(SKIP_AUTH_INTERCEPTOR, true)}));
    }
}
