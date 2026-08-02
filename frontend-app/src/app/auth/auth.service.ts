import {HttpClient, HttpErrorResponse} from '@angular/common/http';
import {Login} from '../login/login';
import {Token} from './token';
import {backends} from '../../environments/environment';
import {Injectable} from '@angular/core';
import {TokenStorageService} from './token-storage.service';
import {Profile} from './profile.model';
import {BehaviorSubject, Observable, throwError} from 'rxjs';
import {catchError, tap} from 'rxjs/operators';

@Injectable({providedIn: 'root'})
export class AuthService {
    private tokenSubject: BehaviorSubject<Token | null> = new BehaviorSubject<Token | null>(null);

    constructor(private http: HttpClient, private storage: TokenStorageService) {
    }

    get token(): BehaviorSubject<Token | null> {
        return this.tokenSubject;
    }

    public login(login: Login): Observable<Token> {
        return this.http.post<Token>(backends.login, login)
            .pipe(
                catchError((res: HttpErrorResponse) => {
                    return throwError(
                        res.error && res.error.message
                            ? res.error.message
                            : 'Unexpected error.'
                    );
                }),
                tap((token: Token) => {
                    this.handleToken(token);
                    this.storage.setToken(token);
                })
            );
    }

    public autoLogin(): void {
        if (!this.storage.hasToken()) {
            return;
        }

        const token = this.storage.getToken();
        if (token.expires_in && Number(token.expires_in) <= Date.now()) {
            this.logout();
            return;
        }
        this.handleToken(token);
    }

    public logout(): void {
        this.tokenSubject.next(null);
        this.storage.removeToken();
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
