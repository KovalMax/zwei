import type {MockedObject} from 'vitest';
import { ChangeDetectorRef } from '@angular/core';
import {TestBed} from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { AdminService, AdminUser } from '../auth/admin.service';
import { AdminComponent } from './admin.component';
import {AdminModule} from './admin.module';

describe('AdminComponent', () => {
    let admins: Pick<MockedObject<AdminService>, 'resendActivationLink' | 'activateUser' | 'users' | 'invitations' | 'giphyMediaSource' | 'updateGiphyMediaSource'>;
    let changeDetector: Pick<MockedObject<ChangeDetectorRef>, 'markForCheck'>;
    let component: AdminComponent;
    const user: AdminUser = {
        id: 'user-1',
        email: 'user@example.test',
        display_name: 'User',
        kyc_status: 1,
        created_at: '2026-08-21T12:00:00Z',
        email_verified: false,
    };

    beforeEach(() => {
        void AdminModule;
        admins = {
            resendActivationLink: vi.fn().mockName("AdminService.resendActivationLink"),
            activateUser: vi.fn().mockName('AdminService.activateUser'),
            users: vi.fn().mockName("AdminService.users"),
            invitations: vi.fn().mockName("AdminService.invitations"),
            giphyMediaSource: vi.fn().mockName('AdminService.giphyMediaSource'),
            updateGiphyMediaSource: vi.fn().mockName('AdminService.updateGiphyMediaSource')
        };
        changeDetector = {
            markForCheck: vi.fn().mockName("ChangeDetectorRef.markForCheck")
        };
        admins.users.mockReturnValue(of([]));
        admins.invitations.mockReturnValue(of([]));
        component = new AdminComponent(admins as unknown as AdminService, changeDetector as unknown as ChangeDetectorRef);
    });

    it('resends an activation link and refreshes the account list', () => {
        admins.resendActivationLink.mockReturnValue(of(void 0));

        component.resendActivation(user);

        expect(admins.resendActivationLink).toHaveBeenCalledTimes(1);

        expect(admins.resendActivationLink).toHaveBeenCalledWith('user-1');
        expect(admins.users).toHaveBeenCalled();
        expect(admins.invitations).toHaveBeenCalled();
        expect(component.activationFeedback).toEqual({message: 'Activation link sent.', kind: 'success'});
        expect(component.isResendingActivation(user)).toBe(false);
    });

    it('reports a resend failure without refreshing the account list', () => {
        admins.resendActivationLink.mockReturnValue(throwError(() => new Error('mail unavailable')));

        component.resendActivation(user);

        expect(component.activationFeedback).toEqual({message: 'Could not resend the activation link.', kind: 'error'});
        expect(admins.users).not.toHaveBeenCalled();
        expect(component.isResendingActivation(user)).toBe(false);
    });

    it('loads and persists the GIPHY source setting using the enabled contract', () => {
        admins.giphyMediaSource.mockReturnValue(of({enabled: true}));
        admins.updateGiphyMediaSource.mockReturnValue(of({enabled: false}));
        component.selectMediaView();
        expect(component.giphyMediaSource).toEqual({enabled: true});
        component.setGiphyEnabled(false);
        expect(admins.updateGiphyMediaSource).toHaveBeenCalledWith(false);
        expect(component.giphyMediaSource).toEqual({enabled: false});
        expect(component.mediaError).toBe('');
    });

    it('restores the persisted setting and reports a failed update', () => {
        admins.giphyMediaSource.mockReturnValue(of({enabled: true}));
        admins.updateGiphyMediaSource.mockReturnValue(throwError(() => new Error('offline')));
        component.selectMediaView();
        component.setGiphyEnabled(false);
        expect(component.giphyMediaSource).toEqual({enabled: true});
        expect(component.mediaError).toBe('Could not save media source settings.');
    });

    it('retries a failed media setting save from the notice action', async () => {
        admins.giphyMediaSource.mockReturnValue(of({enabled: true}));
        admins.updateGiphyMediaSource
            .mockReturnValueOnce(throwError(() => new Error('offline')))
            .mockReturnValueOnce(of({enabled: false}));
        await TestBed.configureTestingModule({
            imports: [AdminModule],
            providers: [{provide: AdminService, useValue: admins}],
        }).compileComponents();
        const fixture = TestBed.createComponent(AdminComponent);
        fixture.detectChanges();
        fixture.componentInstance.selectMediaView();
        fixture.componentInstance.setGiphyEnabled(false);
        fixture.detectChanges();

        const retry = fixture.nativeElement.querySelector('app-notice button') as HTMLButtonElement;
        expect(retry.textContent).toContain('Retry');
        retry.click();
        fixture.detectChanges();

        expect(admins.updateGiphyMediaSource).toHaveBeenCalledTimes(2);
        expect(admins.updateGiphyMediaSource).toHaveBeenLastCalledWith(false);
        expect(fixture.componentInstance.giphyMediaSource).toEqual({enabled: false});
        expect(fixture.componentInstance.mediaError).toBe('');
        fixture.destroy();
    });

    it('renders admin action feedback as a persistent themed notice with its close action', async () => {
        await TestBed.configureTestingModule({
            imports: [AdminModule],
            providers: [{provide: AdminService, useValue: admins}],
        }).compileComponents();
        const fixture = TestBed.createComponent(AdminComponent);
        fixture.detectChanges();
        admins.activateUser.mockReturnValue(of(void 0));
        fixture.componentInstance.activate(user);
        fixture.detectChanges();
        const notice = fixture.nativeElement.querySelector('app-notice .app-notice[role="status"]') as HTMLElement;
        expect(notice.textContent).toContain('Account activated.');
        const close = notice.querySelector('button') as HTMLButtonElement;
        expect(close.textContent).toContain('Close');
        close.click();
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('app-notice .app-notice')).toBeNull();
        fixture.destroy();
    });
});
