import {of, Subject, throwError} from 'rxjs';
import {AdminGuard} from './admin.guard';

describe('AdminGuard', () => {
    it('waits for local session cleanup before redirecting after access fails', () => {
        const cleanup = new Subject<void>();
        const auth = {restore: () => of({}), logout: vi.fn(() => cleanup)};
        const router = {createUrlTree: vi.fn(() => 'login')};
        const guard = new AdminGuard(auth as never, {checkAccess: () => throwError(() => new Error('denied'))} as never, router as never);
        let result: unknown;
        guard.canActivate({} as never, {} as never).subscribe(value => result = value);
        expect(auth.logout).toHaveBeenCalledWith(false);
        expect(result).toBeUndefined();
        cleanup.next();
        cleanup.complete();
        expect(result).toBe('login');
    });
});
