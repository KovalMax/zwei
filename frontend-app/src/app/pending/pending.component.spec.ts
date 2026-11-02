import {TestBed} from '@angular/core/testing';
import {AppModule} from '../app.module';
import {PendingComponent} from './pending.component';

describe('PendingComponent', () => {
    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [AppModule],
        }).compileComponents();
    });

    it('explains automatic activation and sign-in after password setup', () => {
        const fixture = TestBed.createComponent(PendingComponent);
        fixture.detectChanges();

        const page = fixture.nativeElement as HTMLElement;
        const copy = page.querySelector('.auth-intro p')?.textContent ?? '';

        expect(copy).toContain('single-use password setup link');
        expect(copy).toContain('account will activate and sign you in automatically');
        expect(copy).not.toContain('administrator approves');
        expect(page.querySelector('a[routerLink="/login"]')).toBeNull();
        fixture.destroy();
    });
});
