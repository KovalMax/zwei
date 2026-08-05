import {HttpClient, HttpErrorResponse, HttpHeaders} from '@angular/common/http';
import {Login} from '../login/login';
import {Token} from './token';
import {backends} from '../../environments/environment';
import {Injectable} from '@angular/core';
import {Profile} from './profile.model';
import {BehaviorSubject, Observable, of, throwError} from 'rxjs';
import {catchError, shareReplay, tap} from 'rxjs/operators';

@Injectable({providedIn: 'root'})
export class AuthService {
    private tokenSubject: BehaviorSubject<Token | null> = new BehaviorSubject<Token | null>(null);
    private restoreResult?: Observable<Token | null>;

    constructor(private http: HttpClient) {
    }

    get token(): BehaviorSubject<Token | null> {
        return this.tokenSubject;
    }

    public login(login: Login): Observable<Token> {
        return this.http.post<Token>(backends.login, login, {withCredentials: true})
            .pipe(
                catchError((res: HttpErrorResponse) => throwError(() => res)),
                tap((token: Token) => {
                    this.restoreResult = undefined;
                    this.handleToken(token);
                })
            );
    }

    public restore(): Observable<Token | null> {
        const token = this.tokenSubject.value;
        if (token) return of(token);
        if (!this.restoreResult) {
            this.restoreResult = this.http.post<Token>(backends.refresh, {}, {withCredentials: true}).pipe(
                tap(restored => this.handleToken(restored)),
                catchError(() => of(null)),
                shareReplay({bufferSize: 1, refCount: false}),
            );
        }
        return this.restoreResult;
    }

    public logout(revoke = true): Observable<void> {
        const token = this.tokenSubject.value;
        this.tokenSubject.next(null);
        this.restoreResult = of(null);
        if (!revoke) return of(void 0);
        const headers = token ? new HttpHeaders().set('Authorization', token.token_type.concat(' ', token.access_token)) : undefined;
        return this.http.post<void>(backends.logout, {}, {withCredentials: true, headers}).pipe(
            catchError(() => of(void 0)),
        );
    }

    public profile(): Observable<Profile> { return this.http.get<Profile>(`${backends.auth}/api/auth/me`); }

    private handleToken(token: Token): void {
        if (!token) {
            return;
        }

        const expirationDate = new Date(new Date().getTime() + (+token.expires_in * 1000));
        token.expires_in = expirationDate.getTime();

        this.tokenSubject.next(token);
    }
}
