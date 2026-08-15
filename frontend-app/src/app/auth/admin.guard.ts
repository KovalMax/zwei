import {Injectable} from '@angular/core';
import {ActivatedRouteSnapshot, CanActivate, Router, RouterStateSnapshot, UrlTree} from '@angular/router';
import {Observable, of} from 'rxjs';
import {catchError, map, switchMap} from 'rxjs/operators';
import {AuthService} from './auth.service';
import {AdminService} from './admin.service';

@Injectable({providedIn: 'root'})
export class AdminGuard implements CanActivate {
    constructor(private auth: AuthService, private admins: AdminService, private router: Router) {}

    public canActivate(_route: ActivatedRouteSnapshot, _state: RouterStateSnapshot): Observable<boolean | UrlTree> {
        return this.auth.restore().pipe(
            switchMap(token => {
                if (!token) return of(this.router.createUrlTree(['/login']));
                return this.admins.checkAccess().pipe(
                    map(() => true),
                    catchError(() => {
                        this.auth.logout(false);
                        return of(this.router.createUrlTree(['/login']));
                    }),
                );
            }),
        );
    }
}
