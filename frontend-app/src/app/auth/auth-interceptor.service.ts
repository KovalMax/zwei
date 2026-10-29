import {Injectable} from '@angular/core';
import {HttpContextToken, HttpEvent, HttpHandler, HttpInterceptor, HttpRequest, HttpResponse} from '@angular/common/http';
import {catchError, exhaustMap, switchMap, take, tap} from 'rxjs/operators';
import {HttpErrorResponse} from '@angular/common/http';
import {PRIMARY_OUTLET, Router} from '@angular/router';
import {Observable, of, throwError} from 'rxjs';

import {AuthService} from './auth.service';
import {PwaService} from '../pwa/pwa.service';
import {HostService} from './host.service';

export const SKIP_AUTH_INTERCEPTOR = new HttpContextToken<boolean>(() => false);

@Injectable()
export class AuthInterceptorService implements HttpInterceptor {
    constructor(
        private authService: AuthService,
        private router: Router,
        private readonly pwa: PwaService,
        private readonly host: HostService,
    ) {
    }

    intercept(req: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
        if (req.context.get(SKIP_AUTH_INTERCEPTOR)) return next.handle(req);
        // Rotation and logout must never recursively attempt rotation. Logout may
        // already carry the token issued by a pending refresh.
        if (this.isRefreshRequest(req.url) || req.url === this.host.authEndpoint('logout') ||
            (['login', 'refresh', 'logout', 'logout/retry'] as const).some(kind => req.url === this.host.browserSessionEndpoint(kind))) return next.handle(req);
        if (req.url === this.host.authEndpoint('login') || req.url.includes('/register')) return next.handle(req);
        let sentAccessToken: string | undefined;
        return this.authService.token.pipe(
            take(1),
            exhaustMap(token => {
                if (!token) return next.handle(req);
                if (token.expires_in <= Date.now()) {
                    return this.authService.restore().pipe(exhaustMap(restored => {
                        if (!restored) return throwError(() => new HttpErrorResponse({status: this.authService.token.value ? 0 : 401, statusText: 'Session renewal unavailable'}));
                        sentAccessToken = restored.access_token;
                        return next.handle(req.clone({setHeaders: {Authorization: restored.token_type.concat(' ', restored.access_token)}}));
                    }));
                }
                sentAccessToken = token.access_token;
                return next.handle(req.clone({setHeaders: {Authorization: token.token_type.concat(' ', token.access_token)}}));
            }),
            tap(event => {
                if (event instanceof HttpResponse && event.status > 0) this.pwa.confirmNetworkResponse();
            }),
            catchError((error: HttpErrorResponse) => {
                // A 504 can be synthesized by Angular's service worker when an
                // offline API request has no cached response; it is not proof
                // that the network is reachable.
                if (error.status > 0 && error.status !== 504) this.pwa.confirmNetworkResponse();
                if (error.status === 401) {
                    if ((this.authService.token.value?.access_token ?? undefined) !== sentAccessToken) return throwError(() => error);
                    return this.authService.logout(false).pipe(
                        catchError(() => of(void 0)),
                        switchMap(() => {
                            if (!this.authService.token.value && !this.isRefreshRequest(req.url) && !req.url.includes('/login') && !req.url.includes('/register') && !this.isPublicAuthRoute()) {
                                void this.router.navigate(['/login']);
                            }
                            return throwError(() => error);
                        }),
                    );
                }
                return throwError(() => error);
            })
        );
    }

    private isPublicAuthRoute(): boolean {
        const primarySegments = this.router.parseUrl(this.router.url).root.children[PRIMARY_OUTLET]?.segments ?? [];
        const route = primarySegments.map(segment => segment.path).join('/');

        return ['login', 'sign-up', 'pending', 'activate'].includes(route);
    }

    private isRefreshRequest(requestUrl: string): boolean {
        try {
            const configured = new URL(this.host.authEndpoint('refresh'), window.location.origin);
            const request = new URL(requestUrl, window.location.origin);
            const requestHasAuthority = /^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(requestUrl);

            return request.pathname === configured.pathname && (!requestHasAuthority || request.origin === configured.origin);
        } catch {
            return false;
        }
    }
}
