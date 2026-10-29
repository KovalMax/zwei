import {HttpClient, HttpErrorResponse, HttpHeaders} from '@angular/common/http';
import {Login} from '../login/login';
import {Token} from './token';
import {Injectable, OnDestroy} from '@angular/core';
import {Profile, ProfileUpdate} from './profile.model';
import {BehaviorSubject, merge, Observable, of, Subject, throwError} from 'rxjs';
import {catchError, filter, finalize, map, pairwise, shareReplay, switchMap, tap} from 'rxjs/operators';
import {HostService} from './host.service';
import {AuthCookieLockService, AuthCookieLockUnavailableError} from './auth-cookie-lock.service';
import type {BrowserSessionSelector, ContinuedBrowserSession} from './browser-session.client';

export class LogoutCookieUnclearedError extends Error {
    override name = 'LogoutCookieUnclearedError';
}

export type RestoreFailure = 'lock-unavailable' | 'temporarily-unavailable';

interface IntendedSession extends BrowserSessionSelector { subject: string; }
interface PendingLogout extends IntendedSession { receipt: string; }
const intendedKey = 'zwei.intended-session';
const pendingLogoutKey = 'zwei.pending-logout';

@Injectable({providedIn: 'root'})
export class AuthService implements OnDestroy {
    public restoreFailure: RestoreFailure | null = null;
    private tokenSubject: BehaviorSubject<Token | null> = new BehaviorSubject<Token | null>(null);
    private readonly acceptedSession = new Subject<void>();
    public readonly sessionChanges = merge(this.acceptedSession, this.tokenSubject.pipe(pairwise(), filter(([previous, current]) => !!previous && !current), map(() => undefined)));

    public sessionIsCurrent(): boolean {
        if (!this.tokenSubject.value) return false;
        if (this.pendingLogout || !this.sameBinding(this.readBinding(), this.ownedBinding)) {
            this.invalidateLocalSession();
            return false;
        }
        return true;
    }
    private restoreResult?: Observable<Token | null>;
    private refreshInFlight?: Observable<Token | null>;
    private refreshOwnsLock = false;
    private generation = 0;
    private revokeToken?: Token;
    private logoutCookieUncleared = false;
    private browserSelector?: BrowserSessionSelector;
    private revokeBinding?: IntendedSession;
    private ownedBinding?: IntendedSession;
    private readonly storageChanged = (event: StorageEvent): void => {
        if (event.key === pendingLogoutKey && this.pendingLogout) { this.invalidateLocalSession(); return; }
        if (event.key !== intendedKey && event.key !== null) return;
        if (this.ownedBinding && !this.sameBinding(this.readBinding(), this.ownedBinding)) this.invalidateLocalSession();
    };

    constructor(private http: HttpClient, private host: HostService, private cookieLock: AuthCookieLockService) {
        if (typeof window !== 'undefined') window.addEventListener('storage', this.storageChanged);
    }

    ngOnDestroy(): void { if (typeof window !== 'undefined') window.removeEventListener('storage', this.storageChanged); }

    get token(): BehaviorSubject<Token | null> {
        return this.tokenSubject;
    }

    public login(login: Login): Observable<Token> {
        if (this.pendingLogout) return throwError(() => new Error('Complete the pending sign out first'));
        const endpoint = this.host.browserSessionEndpoint('login');
        const generation = ++this.generation;
        return this.cookieLock.run(() => this.pendingLogout ? throwError(() => new Error('Complete the pending sign out first')) : this.http.post<Token | ContinuedBrowserSession>(endpoint, login, {withCredentials: true}))
            .pipe(
                catchError((res: HttpErrorResponse) => throwError(() => res)),
                tap((token: Token) => { if (generation === this.generation) this.acceptToken(token); })
            );
    }

    public acceptToken(token: Token | ContinuedBrowserSession): void {
        if (this.pendingLogout) throw new Error('Complete the pending sign out first');
        const selector = this.selectorOf(token);
        const subject = this.subjectOf(token);
        if (!selector || !subject) throw new Error('Browser session identity missing');
        this.acceptedSession.next();
        try { localStorage.setItem(intendedKey, JSON.stringify({subject, ...selector})); }
        catch { this.tokenSubject.next(null); throw new Error('Browser session storage unavailable'); }
        this.generation++;
        this.browserSelector = this.selectorOf(token);
        this.ownedBinding = {subject, ...selector};
        this.revokeToken = undefined;
        this.revokeBinding = undefined;
        this.logoutCookieUncleared = false;
        this.restoreFailure = null;
        this.restoreResult = undefined;
        this.handleToken(token);
    }

    public restore(revocationToken?: Token): Observable<Token | null> {
        if (!revocationToken && this.pendingLogout) { this.invalidateLocalSession(); return of(null); }
        const token = this.tokenSubject.value || revocationToken;
        if (this.tokenSubject.value && !this.sameBinding(this.readBinding(), this.ownedBinding)) {
            this.invalidateLocalSession();
            return of(null);
        }
        if (token && token.expires_in > Date.now()) return of(token);
        let stored: IntendedSession | null;
        try { stored = this.parseBinding(localStorage.getItem(intendedKey)); }
        catch { this.invalidateLocalSession(); return of(null); }
        const binding = stored || (revocationToken ? this.revokeBinding : null);
        if (!binding || (token && this.subjectOf(token) !== binding.subject)) return of(null);
        if (!this.ownedBinding) this.ownedBinding = binding;
        const selector = this.browserSelector || binding;
        const generation = this.generation;
        if (!this.refreshInFlight) {
            let requestedGeneration: string | undefined;
            // Cookie rotation must never proceed without cross-tab exclusion.
            const refresh = this.cookieLock.run(() => {
                if (!revocationToken && this.pendingLogout) return of(null);
                const logoutRefresh = !!revocationToken && this.revokeToken === revocationToken && !this.tokenSubject.value && this.generation === generation + 1;
                let current: IntendedSession | null | undefined;
                try { current = this.parseBinding(localStorage.getItem(intendedKey)) || (logoutRefresh ? this.revokeBinding : null); }
                catch { return of(null); }
                if (!current || current.subject !== binding.subject || current.browser_id !== binding.browser_id || (generation !== this.generation && !logoutRefresh)) return of(null);
                requestedGeneration = current.generation;
                this.refreshOwnsLock = true;
                return this.http.post<Token | ContinuedBrowserSession>(this.host.browserSessionEndpoint('refresh'), {browser_id: current.browser_id, generation: current.generation}, {withCredentials: true}).pipe(finalize(() => this.refreshOwnsLock = false));
            });
            this.refreshInFlight = refresh.pipe(
                map(restored => {
                    if (!restored) return null;
                    this.restoreFailure = null;
                    const nextSelector = this.selectorOf(restored);
                    if ((!nextSelector || nextSelector.browser_id !== selector.browser_id) ||
                        this.subjectOf(restored) !== binding.subject) {
                        if (generation === this.generation) {
                            this.tokenSubject.next(null);
                            this.restoreResult = of(null);
                        }
                        return null;
                    }
                    if (generation === this.generation) {
                        const current = this.readBinding();
                        if (!current || current.subject !== binding.subject || current.browser_id !== binding.browser_id || current.generation !== requestedGeneration) return null;
                        try { localStorage.setItem(intendedKey, JSON.stringify({subject: binding.subject, ...nextSelector})); }
                        catch { this.tokenSubject.next(null); return null; }
                        this.browserSelector = nextSelector;
                        this.ownedBinding = {subject: binding.subject, ...nextSelector};
                    }
                    return restored;
                }),
                catchError((error: unknown) => {
                    if (error instanceof AuthCookieLockUnavailableError) this.restoreFailure = 'lock-unavailable';
                    else if (!(error instanceof HttpErrorResponse) || error.status !== 401) this.restoreFailure = 'temporarily-unavailable';
                    if (error instanceof HttpErrorResponse && error.status === 401 && generation === this.generation) {
                        this.restoreFailure = null;
                        this.tokenSubject.next(null);
                        this.restoreResult = of(null);
                    }
                    return of(null);
                }),
                finalize(() => this.refreshInFlight = undefined),
                shareReplay({bufferSize: 1, refCount: false}),
            );
        }
        return this.refreshInFlight.pipe(map(restored => {
            if (generation !== this.generation) return null;
            const current = this.tokenSubject.value;
            if (current && restored && (!this.subjectOf(current) || this.subjectOf(current) !== this.subjectOf(restored))) {
                this.tokenSubject.next(null);
                this.restoreResult = of(null);
                return null;
            }
            if (restored && this.tokenSubject.value !== restored) this.handleToken(restored);
            return restored;
        }));
    }

    public logout(revoke = true): Observable<void> {
        if (revoke && this.logoutCookieUncleared) return throwError(() => new LogoutCookieUnclearedError());
        if (revoke && !this.tokenSubject.value && this.pendingLogout) return this.retryPendingLogout();
        const token = this.tokenSubject.value || this.revokeToken;
        const selector = this.browserSelector || this.ownedBinding || this.readBinding() || undefined;
        this.revokeBinding = this.ownedBinding || this.revokeBinding || (revoke ? this.readBinding() || undefined : undefined);
        const needsRefresh = !!(revoke && token && token.expires_in <= Date.now());
        if (revoke) this.revokeToken = token || undefined;
        const pending = this.refreshInFlight;
        const ownedBinding = this.ownedBinding || this.revokeBinding;
        let reserved: PendingLogout | undefined;
        let reservationError: Error | undefined;
        // An active refresh still holds the shared lock. Persist the recovery
        // intent before its response can be lost or the page can disappear.
        if (revoke && pending && this.refreshOwnsLock) {
            try {
                if (!ownedBinding || !this.sameBinding(this.parseBinding(localStorage.getItem(intendedKey)), ownedBinding) || localStorage.getItem(pendingLogoutKey)) {
                    throw new Error('Browser session changed');
                }
                const bytes = crypto.getRandomValues(new Uint8Array(32));
                const receipt = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
                reserved = {...ownedBinding, receipt};
                localStorage.setItem(pendingLogoutKey, JSON.stringify(reserved));
            } catch { reservationError = new Error('Unable to preserve pending sign out'); }
        }
        this.generation++;
        const logoutGeneration = this.generation;
        this.ownedBinding = undefined;
        this.tokenSubject.next(null);
        this.restoreResult = of(null);
        if (reservationError) return throwError(() => reservationError);
        const result = (pending || of(null)).pipe(switchMap(rotated => {
            if (revoke && pending && !rotated && reserved) return this.retryPendingLogout();
            if (revoke && pending && needsRefresh && !rotated) {
                if (typeof navigator === 'undefined' || typeof navigator.locks?.request !== 'function') return throwError(() => new AuthCookieLockUnavailableError());
                return throwError(() => new Error('Unable to refresh session for logout'));
            }
            if (rotated && token && (!this.subjectOf(token) || this.subjectOf(token) !== this.subjectOf(rotated))) {
                return throwError(() => new Error('Session identity changed during logout'));
            }
            if (!revoke) return this.cookieLock.run(() => this.removeOwnedBinding(ownedBinding));
            const current = rotated || token;
            const revokeSelector = rotated ? this.selectorOf(rotated) : selector;
            if (!revokeSelector || revokeSelector.browser_id !== selector?.browser_id) return throwError(() => new Error('Browser session unavailable'));
            if (this.generation === logoutGeneration) {
                this.revokeToken = rotated ? {...rotated, expires_in: Date.now() + rotated.expires_in * 1000} : current || undefined;
                this.browserSelector = revokeSelector;
            }
            return this.cookieLock.run(() => {
                let pendingBinding: PendingLogout | undefined;
                try {
                    const existing = localStorage.getItem(pendingLogoutKey);
                    const intended = localStorage.getItem(intendedKey);
                    if (!ownedBinding || (existing && !this.samePending(this.parsePendingLogout(existing), reserved)) ||
                        (intended && !this.sameBinding(this.parseBinding(intended), ownedBinding)) || (!intended && !existing)) {
                        return throwError(() => new Error('Browser session changed'));
                    }
                    const bytes = crypto.getRandomValues(new Uint8Array(32));
                    const receipt = reserved?.receipt || btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
                    pendingBinding = {...ownedBinding, ...revokeSelector, receipt};
                    localStorage.setItem(pendingLogoutKey, JSON.stringify(pendingBinding));
                    this.revokeBinding = pendingBinding;
                } catch { return throwError(() => new Error('Browser session storage unavailable')); }
                if (!current || (needsRefresh && !rotated)) return this.sendPendingLogout(pendingBinding);
                return of(current).pipe(
                    switchMap(refreshed => {
                        const next = this.selectorOf(refreshed);
                        const intended = localStorage.getItem(intendedKey);
                        if (!next || next.browser_id !== revokeSelector.browser_id || this.subjectOf(refreshed) !== ownedBinding?.subject ||
                            (intended && !this.sameBinding(this.parseBinding(intended), ownedBinding)) || !this.samePending(this.parsePendingLogout(localStorage.getItem(pendingLogoutKey)), pendingBinding)) {
                            return throwError(() => new Error('Session identity changed during logout'));
                        }
                        pendingBinding = {...ownedBinding, ...next, receipt: pendingBinding!.receipt};
                        try { localStorage.setItem(pendingLogoutKey, JSON.stringify(pendingBinding)); }
                        catch { return throwError(() => new Error('Browser session storage unavailable')); }
                        this.revokeBinding = pendingBinding;
                        if (this.generation === logoutGeneration) {
                            this.revokeToken = refreshed === current ? current : {...refreshed, expires_in: Date.now() + refreshed.expires_in * 1000};
                            this.browserSelector = next;
                        }
                        const headers = new HttpHeaders().set('Authorization', refreshed.token_type.concat(' ', refreshed.access_token));
                        return this.removeOwnedBinding(ownedBinding).pipe(
                            switchMap(() => this.http.post<void>(this.host.browserSessionEndpoint('logout'), {...next, receipt: pendingBinding!.receipt}, {withCredentials: true, headers})),
                            tap(() => this.clearPendingLogout(pendingBinding)),
                        );
                    }),
                );
            }).pipe(
                tap(() => { if (this.generation === logoutGeneration) { this.revokeToken = undefined; this.revokeBinding = undefined; this.browserSelector = undefined; } }),
                catchError((error: HttpErrorResponse) => {
                    const confirmed = (error.status === 409 && error.error?.error === 'sessions revoked; refresh cookie ownership mismatch') ||
                        (error.status === 500 && error.error?.error === 'sessions revoked; could not verify refresh cookie');
                    if (!confirmed) return throwError(() => error);
                    if (this.generation === logoutGeneration) {
                        this.revokeToken = undefined;
                        this.logoutCookieUncleared = true;
                        this.restoreResult = of(null);
                    }
                    return throwError(() => new LogoutCookieUnclearedError());
                }),
            );
        }));
        // Once started, local invalidation must outlive a cancelled HTTP request or guard.
        return result.pipe(shareReplay({bufferSize: 1, refCount: false}));
    }

    public profile(): Observable<Profile> { return this.http.get<Profile>(this.host.authEndpoint('profile')); }

    // Storage failures and malformed intents fail closed: neither restores nor new sessions may proceed.
    public get pendingLogout(): boolean {
        try { return localStorage.getItem(pendingLogoutKey) !== null; } catch { return true; }
    }

    public retryPendingLogout(): Observable<void> {
        return this.cookieLock.run(() => {
            let binding: PendingLogout | null;
            try { binding = this.parsePendingLogout(localStorage.getItem(pendingLogoutKey)); }
            catch { return throwError(() => new Error('Browser session storage unavailable')); }
            if (!binding) return throwError(() => new Error('Pending sign out unavailable'));
            const intended = this.readBinding();
            if (intended && !this.sameBinding(intended, binding)) return throwError(() => new Error('Browser session changed'));
            return this.sendPendingLogout(binding);
        });
    }

    private sendPendingLogout(binding: PendingLogout): Observable<void> {
        return this.http.post<void>(this.host.browserSessionEndpoint('logout/retry'), binding, {withCredentials: true}).pipe(
            switchMap(() => this.samePending(this.parsePendingLogout(localStorage.getItem(pendingLogoutKey)), binding)
                ? this.removeOwnedBinding(binding) : throwError(() => new Error('Pending sign out changed'))),
            tap(() => this.clearPendingLogout(binding)),
        );
    }

    private clearPendingLogout(binding: PendingLogout | undefined): void {
        try {
            const current = this.parsePendingLogout(localStorage.getItem(pendingLogoutKey));
            if (!this.sameBinding(current, binding) || current?.receipt !== binding?.receipt) throw new Error('Pending sign out changed');
            localStorage.removeItem(pendingLogoutKey);
        } catch { throw new Error('Browser session storage unavailable'); }
    }

    // Explicitly abandon an unconfirmed operation, never claim that sessions were revoked.
    public abandonPendingLogout(): Observable<void> {
        return this.cookieLock.run(() => {
            try {
                const raw = localStorage.getItem(pendingLogoutKey);
                if (raw === null) return throwError(() => new Error('Pending sign out unavailable'));
                const binding = this.parsePendingLogout(raw);
                const intended = localStorage.getItem(intendedKey);
                if (localStorage.getItem(pendingLogoutKey) !== raw) return throwError(() => new Error('Pending sign out changed'));
                if (intended && binding && this.sameBinding(this.parseBinding(intended), binding)) localStorage.removeItem(intendedKey);
                localStorage.removeItem(pendingLogoutKey);
                this.invalidateLocalSession();
                return of(void 0);
            } catch { return throwError(() => new Error('Browser session storage unavailable')); }
        });
    }

    private parsePendingLogout(raw: string | null): PendingLogout | null {
        const binding = this.parseBinding(raw);
        if (!binding || !raw) return null;
        try {
            const value: unknown = JSON.parse(raw);
            if (typeof value !== 'object' || value === null || !('receipt' in value) || typeof value.receipt !== 'string' || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value.receipt)) return null;
            return {...binding, receipt: value.receipt};
        } catch { return null; }
    }

    private samePending(a: PendingLogout | null | undefined, b: PendingLogout | null | undefined): boolean {
        return this.sameBinding(a, b) && a?.receipt === b?.receipt;
    }

    public updateProfile(update: ProfileUpdate): Observable<Profile> {
        return this.http.patch<Profile>(this.host.authEndpoint('profile'), update);
    }

    public mediaPolicy(): Observable<{giphy_enabled: boolean}> {
        return this.http.get<{giphy_enabled: boolean}>(this.host.authEndpoint('media-policy'));
    }

    public activate(token: string): Observable<{status: string}> {
        return this.http.post<{status: string}>(this.host.authEndpoint('activate'), {}, {params: {token}});
    }

    public defaultAuthenticatedRoute(): string {
        return this.host.defaultAuthenticatedRoute();
    }

    private handleToken(token: Token): void {
        if (!token) {
            return;
        }

        const expirationDate = new Date(new Date().getTime() + (+token.expires_in * 1000));
        token.expires_in = expirationDate.getTime();

        this.tokenSubject.next(token);
    }

    private subjectOf(token: Token): string | null {
        try {
            const payload = token.access_token.split('.')[1];
            if (!payload) return null;
            const claims: unknown = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
            if (typeof claims !== 'object' || claims === null || !('sub' in claims)) return null;
            return typeof claims.sub === 'string' && claims.sub.length > 0 ? claims.sub : null;
        } catch {
            return null;
        }
    }

    private readBinding(): IntendedSession | null {
        try {
            return this.parseBinding(localStorage.getItem(intendedKey));
        } catch { return null; }
    }

    private parseBinding(raw: string | null): IntendedSession | null {
        try {
            if (!raw) return null;
            const value: unknown = JSON.parse(raw);
            if (typeof value !== 'object' || value === null || !('subject' in value) || !('browser_id' in value) || !('generation' in value)) return null;
            if (typeof value.subject !== 'string' || !value.subject || typeof value.browser_id !== 'string' || !value.browser_id || typeof value.generation !== 'string' || !value.generation) return null;
            return {subject: value.subject, browser_id: value.browser_id, generation: value.generation};
        } catch { return null; }
    }

    private sameBinding(a: IntendedSession | null | undefined, b: IntendedSession | null | undefined): boolean {
        return !!a && !!b && a.subject === b.subject && a.browser_id === b.browser_id && a.generation === b.generation;
    }

    private removeOwnedBinding(owned: IntendedSession | undefined): Observable<void> {
        try {
            // Read directly so storage failure is not confused with an absent binding.
            const raw = localStorage.getItem(intendedKey);
            if (raw && this.sameBinding(this.parseBinding(raw), owned)) localStorage.removeItem(intendedKey);
            return of(void 0);
        } catch { return throwError(() => new Error('Browser session storage unavailable')); }
    }

    private invalidateLocalSession(): void {
        this.generation++;
        this.ownedBinding = undefined;
        this.browserSelector = undefined;
        this.revokeToken = undefined;
        this.revokeBinding = undefined;
        this.restoreResult = of(null);
        this.tokenSubject.next(null);
    }

    private selectorOf(token: Token | ContinuedBrowserSession): BrowserSessionSelector | undefined {
        if (!('browser_id' in token) || !('generation' in token) ||
            typeof token.browser_id !== 'string' || !token.browser_id ||
            typeof token.generation !== 'string' || !token.generation) return undefined;
        return {browser_id: token.browser_id, generation: token.generation};
    }
}
