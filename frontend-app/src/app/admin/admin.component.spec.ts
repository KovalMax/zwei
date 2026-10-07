import type {MockedObject} from 'vitest';
import { ChangeDetectorRef } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { of, throwError } from 'rxjs';

import { AdminService, AdminUser } from '../auth/admin.service';
import { AdminComponent } from './admin.component';
import {AdminModule} from './admin.module';

describe('AdminComponent', () => {
    let admins: Pick<MockedObject<AdminService>, 'resendActivationLink' | 'users' | 'invitations'>;
    let snack: Pick<MockedObject<MatSnackBar>, 'open'>;
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
            users: vi.fn().mockName("AdminService.users"),
            invitations: vi.fn().mockName("AdminService.invitations")
        };
        snack = {
            open: vi.fn().mockName("MatSnackBar.open")
        };
        changeDetector = {
            markForCheck: vi.fn().mockName("ChangeDetectorRef.markForCheck")
        };
        admins.users.mockReturnValue(of([]));
        admins.invitations.mockReturnValue(of([]));
        component = new AdminComponent(admins as unknown as AdminService, snack as unknown as MatSnackBar, changeDetector as unknown as ChangeDetectorRef);
    });

    it('resends an activation link and refreshes the account list', () => {
        admins.resendActivationLink.mockReturnValue(of(void 0));

        component.resendActivation(user);

        expect(admins.resendActivationLink).toHaveBeenCalledTimes(1);

        expect(admins.resendActivationLink).toHaveBeenCalledWith('user-1');
        expect(admins.users).toHaveBeenCalled();
        expect(admins.invitations).toHaveBeenCalled();
        expect(component.activationFeedback).toEqual({message: 'Activation link sent.', kind: 'success'});
        expect(snack.open).not.toHaveBeenCalled();
        expect(component.isResendingActivation(user)).toBe(false);
    });

    it('reports a resend failure without refreshing the account list', () => {
        admins.resendActivationLink.mockReturnValue(throwError(() => new Error('mail unavailable')));

        component.resendActivation(user);

        expect(component.activationFeedback).toEqual({message: 'Could not resend the activation link.', kind: 'error'});
        expect(snack.open).not.toHaveBeenCalled();
        expect(admins.users).not.toHaveBeenCalled();
        expect(component.isResendingActivation(user)).toBe(false);
    });
});
