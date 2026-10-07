import {Router, UrlTree} from '@angular/router';
import {of} from 'rxjs';

import {AuthGuard} from './auth.guard';

describe('AuthGuard', () => {
    it('returns the login UrlTree when refresh restores no token', () => {
        const loginTree = {} as UrlTree;
        const auth = {restore: vi.fn(() => of(null))};
        const router = {createUrlTree: vi.fn(() => loginTree)};
        const guard = new AuthGuard(auth as never, router as unknown as Router);

        let result: boolean | UrlTree | undefined;
        guard.canActivate({} as never, {} as never).subscribe(value => result = value);

        expect(result).toBe(loginTree);
        expect(router.createUrlTree).toHaveBeenCalledWith(['login']);
    });
});
