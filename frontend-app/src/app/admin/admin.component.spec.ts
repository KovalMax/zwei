import {ChangeDetectorRef} from '@angular/core';
import {MatSnackBar} from '@angular/material/snack-bar';
import {of, throwError} from 'rxjs';

import {AdminService, AdminUser} from '../auth/admin.service';
import {AdminComponent} from './admin.component';

describe('AdminComponent', () => {
    let admins: jasmine.SpyObj<AdminService>;
    let snack: jasmine.SpyObj<MatSnackBar>;
    let changeDetector: jasmine.SpyObj<ChangeDetectorRef>;
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
        admins = jasmine.createSpyObj<AdminService>('AdminService', ['resendActivationLink', 'users', 'invitations']);
        snack = jasmine.createSpyObj<MatSnackBar>('MatSnackBar', ['open']);
        changeDetector = jasmine.createSpyObj<ChangeDetectorRef>('ChangeDetectorRef', ['markForCheck']);
        admins.users.and.returnValue(of([]));
        admins.invitations.and.returnValue(of([]));
        component = new AdminComponent(admins, snack, changeDetector);
    });

    it('resends an activation link and refreshes the account list', () => {
        admins.resendActivationLink.and.returnValue(of(void 0));

        component.resendActivation(user);

        expect(admins.resendActivationLink).toHaveBeenCalledOnceWith('user-1');
        expect(admins.users).toHaveBeenCalled();
        expect(admins.invitations).toHaveBeenCalled();
        expect(snack.open).toHaveBeenCalledWith('Activation link sent.', 'Close', {duration: 5000});
        expect(component.isResendingActivation(user)).toBeFalse();
    });

    it('reports a resend failure without refreshing the account list', () => {
        admins.resendActivationLink.and.returnValue(throwError(() => new Error('mail unavailable')));

        component.resendActivation(user);

        expect(snack.open).toHaveBeenCalledWith('Could not resend the activation link.', 'Close', {duration: 10000});
        expect(admins.users).not.toHaveBeenCalled();
        expect(component.isResendingActivation(user)).toBeFalse();
    });
});
