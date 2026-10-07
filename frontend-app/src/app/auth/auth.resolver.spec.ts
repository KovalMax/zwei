import {Router} from '@angular/router';
import {of} from 'rxjs';

import {AuthResolver} from './auth.resolver';

describe('AuthResolver', () => {
    it('keeps the public route active when refresh restores no token', () => {
        const auth = {restore: vi.fn(() => of(null)), defaultAuthenticatedRoute: vi.fn(() => 'home')};
        const router = {navigate: vi.fn()};
        const resolver = new AuthResolver(router as unknown as Router, auth as never);

        let result: unknown;
        resolver.resolve({} as never, {url: '/sign-up'} as never).subscribe(value => result = value);

        expect(result).toBe(true);
        expect(router.navigate).not.toHaveBeenCalled();
    });
});
