import {ChangeDetectorRef} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {of, throwError} from 'rxjs';
import {AuthService} from '../auth/auth.service';
import {Profile} from '../auth/profile.model';
import {HostService} from '../auth/host.service';
import {BrowserNotificationService} from '../notifications/notification.service';
import {ProfileComponent} from './profile.component';
import {AppModule} from '../app.module';

describe('ProfileComponent media preference', () => {
    const profile: Profile = {id: 'user-1', email: 'user@example.test', display_name: 'User', retention_period: '30d', auto_load_approved_media: false};
    let component: ProfileComponent;
    let auth: {updateProfile: ReturnType<typeof vi.fn>};

    beforeEach(async () => {
        await TestBed.configureTestingModule({imports: [AppModule]}).compileComponents();
        auth = {updateProfile: vi.fn()};
        component = new ProfileComponent(auth as unknown as AuthService, {markForCheck: vi.fn()} as unknown as ChangeDetectorRef,
            {isAdminHost: () => false} as unknown as HostService, {} as BrowserNotificationService);
        component.profile = profile;
    });

    it('persists an explicit opt-in and adopts the saved account preference', () => {
        auth.updateProfile.mockReturnValue(of({...profile, auto_load_approved_media: true}));
        component.setMediaAutoLoad(true);
        expect(auth.updateProfile).toHaveBeenCalledWith({auto_load_approved_media: true});
        expect(component.profile?.auto_load_approved_media).toBe(true);
        expect(component.mediaSaving).toBe(false);
        expect(component.mediaSaveError).toBe(false);
    });

    it('restores the last persisted value after preference save fails', () => {
        auth.updateProfile.mockReturnValue(throwError(() => new Error('offline')));
        component.setMediaAutoLoad(true);
        expect(component.profile?.auto_load_approved_media).toBe(false);
        expect(component.mediaSaving).toBe(false);
        expect(component.mediaSaveError).toBe(true);
    });
});
