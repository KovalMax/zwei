import {HttpContext, HttpErrorResponse, HttpRequest, HttpResponse} from '@angular/common/http';
import {DefaultUrlSerializer} from '@angular/router';
import {BehaviorSubject, of, Subject, throwError} from 'rxjs';

import {AuthInterceptorService, SKIP_AUTH_INTERCEPTOR} from './auth-interceptor.service';
import {AuthService} from './auth.service';
import {AuthCookieLockService} from './auth-cookie-lock.service';

describe('AuthInterceptorService connectivity confirmation', () => {
    const pwa = {confirmNetworkResponse: vi.fn()};
    const auth = {
        token: of(null),
        logout: vi.fn(() => of(void 0)),
    };
    const urlSerializer = new DefaultUrlSerializer();
    const router = {
        url: '/home',
        navigate: vi.fn().mockResolvedValue(true),
        parseUrl: (url: string) => urlSerializer.parse(url),
    };
    const host = {authEndpoint: vi.fn(() => 'https://chat.localhost/api/auth/refresh'), browserSessionEndpoint: (kind: string) => `https://chat.localhost/api/auth/v2/${kind}`};
    let interceptor: AuthInterceptorService;

    beforeEach(() => {
        vi.clearAllMocks();
        router.url = '/home';
        interceptor = new AuthInterceptorService(auth as never, router as never, pwa as never, host as never);
    });

    afterEach(() => {
        localStorage.removeItem('zwei.intended-session');
        vi.unstubAllGlobals();
    });

    it('confirms connectivity for a successful HTTP response', () => {
        const request = new HttpRequest('GET', '/api/status');
        const handler = {handle: vi.fn().mockReturnValue(of(new HttpResponse({status: 200})))};

        interceptor.intercept(request, handler).subscribe();

        expect(pwa.confirmNetworkResponse).toHaveBeenCalledOnce();
    });

    it('passes explicitly external public requests through without auth or global response handling', () => {
        const request = new HttpRequest('GET', 'https://api.giphy.com/v1/gifs/search', {}, {context: new HttpContext().set(SKIP_AUTH_INTERCEPTOR, true), withCredentials: false, referrerPolicy: 'no-referrer'});
        const handler = {handle: vi.fn().mockReturnValue(of(new HttpResponse({status: 200})))};

        interceptor.intercept(request, handler).subscribe();

        expect(handler.handle).toHaveBeenCalledWith(request);
        expect(request.headers.has('Authorization')).toBe(false);
        expect(pwa.confirmNetworkResponse).not.toHaveBeenCalled();
    });

    it('confirms connectivity for real HTTP errors, but not service-worker timeouts or network failures', () => {
        const request = new HttpRequest('GET', '/api/status');
        const handler = {handle: vi.fn().mockReturnValue(throwError(() => new HttpErrorResponse({status: 404})))};

        interceptor.intercept(request, handler).subscribe({error: () => undefined});
        expect(pwa.confirmNetworkResponse).toHaveBeenCalledOnce();

        pwa.confirmNetworkResponse.mockClear();
        const timeoutHandler = {handle: vi.fn().mockReturnValue(throwError(() => new HttpErrorResponse({status: 504})))};
        interceptor.intercept(request, timeoutHandler).subscribe({error: () => undefined});
        expect(pwa.confirmNetworkResponse).not.toHaveBeenCalled();

        const offlineHandler = {handle: vi.fn().mockReturnValue(throwError(() => new HttpErrorResponse({status: 0})))};
        interceptor.intercept(request, offlineHandler).subscribe({error: () => undefined});
        expect(pwa.confirmNetworkResponse).not.toHaveBeenCalled();
    });

    it('does not navigate for a refresh 401 when Router.url is still the previous route', () => {
        router.url = '/';
        const request = new HttpRequest('POST', '/api/auth/refresh', {});
        const unauthorized = new HttpErrorResponse({status: 401});
        const handler = {handle: vi.fn().mockReturnValue(throwError(() => unauthorized))};
        let receivedError: unknown;

        interceptor.intercept(request, handler).subscribe({error: error => receivedError = error});

        expect(auth.logout).not.toHaveBeenCalled();
        expect(router.navigate).not.toHaveBeenCalled();
        expect(receivedError).toBe(unauthorized);
    });

    it('renews before sending an expired-token mutation without replaying it', () => {
        const token = new BehaviorSubject({token_type: 'Bearer', access_token: 'old', expires_in: 1});
        const renewal = vi.fn().mockReturnValue(of({token_type: 'Bearer', access_token: 'new', expires_in: Date.now() + 900000}));
        const instance = new AuthInterceptorService({token, restore: renewal, logout: vi.fn()} as never, router as never, pwa as never, host as never);
        const handler = {handle: vi.fn().mockReturnValue(of(new HttpResponse({status: 200})))};
        instance.intercept(new HttpRequest('POST', '/api/chat', {}), handler).subscribe();
        expect(renewal).toHaveBeenCalledOnce();
        expect(handler.handle).toHaveBeenCalledOnce();
        expect(handler.handle.mock.calls[0][0].headers.get('Authorization')).toBe('Bearer new');
    });

    it('does not send a mutation or sign out on transient renewal failure', () => {
        const token = new BehaviorSubject({token_type: 'Bearer', access_token: 'old', expires_in: 1});
        const logout = vi.fn();
        const instance = new AuthInterceptorService({token, restore: () => of(null), logout} as never, router as never, pwa as never, host as never);
        const handler = {handle: vi.fn()};
        instance.intercept(new HttpRequest('POST', '/api/chat', {}), handler).subscribe({error: () => undefined});
        expect(handler.handle).not.toHaveBeenCalled();
        expect(logout).not.toHaveBeenCalled();
    });

    it('does not send a pending mutation after renewal rejects an account change', () => {
        const token = new BehaviorSubject<{token_type: string; access_token: string; expires_in: number} | null>({token_type: 'Bearer', access_token: 'old', expires_in: 1});
        const instance = new AuthInterceptorService({token, restore: () => { token.next(null); return of(null); }, logout: vi.fn()} as never, router as never, pwa as never, host as never);
        const handler = {handle: vi.fn()};
        instance.intercept(new HttpRequest('POST', '/api/chat', {}), handler).subscribe({error: () => undefined});
        expect(handler.handle).not.toHaveBeenCalled();
    });

    it('does not clear a newer session when an anonymous request fails late', () => {
        const token = new BehaviorSubject<{token_type: string; access_token: string; expires_in: number} | null>(null);
        const logout = vi.fn();
        const response = new Subject<HttpResponse<unknown>>();
        const instance = new AuthInterceptorService({token, logout} as never, router as never, pwa as never, host as never);
        instance.intercept(new HttpRequest('GET', '/api/home'), {handle: () => response}).subscribe({error: () => undefined});
        token.next({token_type: 'Bearer', access_token: 'new', expires_in: Date.now() + 900000});
        response.error(new HttpErrorResponse({status: 401}));
        expect(logout).not.toHaveBeenCalled();
        expect(router.navigate).not.toHaveBeenCalled();
    });

    it('does not treat the same refresh path on a different origin as the configured endpoint', () => {
        router.url = '/home';
        const request = new HttpRequest('GET', 'https://other.example/api/auth/refresh');
        const handler = {handle: vi.fn().mockReturnValue(throwError(() => new HttpErrorResponse({status: 401})))};

        interceptor.intercept(request, handler).subscribe({error: () => undefined});

        expect(router.navigate).toHaveBeenCalledWith(['/login']);
    });

    it('redirects a protected route to login after a 401', () => {
        router.url = '/home';
        const request = new HttpRequest('GET', '/api/home');
        const handler = {handle: vi.fn().mockReturnValue(throwError(() => new HttpErrorResponse({status: 401})))};

        interceptor.intercept(request, handler).subscribe({error: () => undefined});

        expect(auth.logout).toHaveBeenCalledOnce();
        expect(auth.logout).toHaveBeenCalledWith(false);
        expect(router.navigate).toHaveBeenCalledOnce();
        expect(router.navigate).toHaveBeenCalledWith(['/login']);
    });

    it('removes the rejected session binding so a reload cannot restore it', () => {
        vi.stubGlobal('navigator', {});
        const service = new AuthService({} as never, host as never, {run: (work: () => unknown) => work()} as AuthCookieLockService);
        const access_token = `header.${btoa(JSON.stringify({sub: 'a'}))}.signature`;
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token, expires_in: 900});
        const instance = new AuthInterceptorService(service, router as never, pwa as never, host as never);
        instance.intercept(new HttpRequest('GET', '/api/home'), {handle: () => throwError(() => new HttpErrorResponse({status: 401}))}).subscribe({error: () => undefined});
        expect(localStorage.getItem('zwei.intended-session')).toBeNull();
        const reloaded = new AuthService({} as never, host as never, new AuthCookieLockService());
        reloaded.restore().subscribe(value => expect(value).toBeNull());
        service.ngOnDestroy();
        reloaded.ngOnDestroy();
        vi.unstubAllGlobals();
    });

    it('does not remove a newer binding when the old request is rejected', () => {
        vi.stubGlobal('navigator', {});
        const service = new AuthService({} as never, host as never, {run: (work: () => unknown) => work()} as AuthCookieLockService);
        const access_token = `header.${btoa(JSON.stringify({sub: 'a'}))}.signature`;
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token, expires_in: 900});
        const response = new Subject<HttpResponse<unknown>>();
        const instance = new AuthInterceptorService(service, router as never, pwa as never, host as never);
        instance.intercept(new HttpRequest('GET', '/api/home'), {handle: () => response}).subscribe({error: () => undefined});
        const newer = JSON.stringify({subject: 'b', browser_id: 'other', generation: 'two'});
        localStorage.setItem('zwei.intended-session', newer);
        response.error(new HttpErrorResponse({status: 401}));
        expect(localStorage.getItem('zwei.intended-session')).toBe(newer);
        localStorage.removeItem('zwei.intended-session');
        service.ngOnDestroy();
        vi.unstubAllGlobals();
    });
});
