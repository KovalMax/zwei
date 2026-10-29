import {Router, UrlTree} from '@angular/router';
import {of} from 'rxjs';

import {AuthGuard} from './auth.guard';

describe('AuthGuard', () => {
    it('redirects anonymous users to sign in', () => {
        const router = {createUrlTree: vi.fn(() => ({} as UrlTree))};
        const guard = new AuthGuard({restore: () => of(null)} as never, router as never);
        guard.canActivate({} as never, {} as never).subscribe();
        expect(router.createUrlTree).toHaveBeenCalledWith(['login']);
    });
});
