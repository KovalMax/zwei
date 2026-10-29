import {ComponentFixture, TestBed} from '@angular/core/testing';

import {LoginComponent} from './login.component';
import {AppModule} from '../app.module';
import {AuthService} from '../auth/auth.service';
import {of} from 'rxjs';

describe('LoginComponent', () => {
    let component: LoginComponent;
    let fixture: ComponentFixture<LoginComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [AppModule]
        })
            .compileComponents();
    });

    beforeEach(() => {
        fixture = TestBed.createComponent(LoginComponent);
        component = fixture.componentInstance;
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    it('shows session recovery and retries without submitting credentials', () => {
        const auth = TestBed.inject(AuthService);
        auth.restoreFailure = 'temporarily-unavailable';
        const restore = vi.spyOn(auth, 'restore').mockReturnValue(of(null));
        const login = vi.spyOn(auth, 'login');
        fixture.detectChanges();
        expect(fixture.nativeElement.textContent).toContain('temporarily unavailable');
        const button = Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>)
            .find(item => item.textContent?.includes('Retry session'));
        expect(button).toBeTruthy();
        button?.click();
        expect(restore).toHaveBeenCalled();
        expect(login).not.toHaveBeenCalled();
    });
});
