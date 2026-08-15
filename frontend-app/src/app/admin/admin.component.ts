import {ChangeDetectorRef, Component, OnInit} from '@angular/core';
import {AdminService, AdminUser, Invitation, KYCStatus} from '../auth/admin.service';
import {MatSnackBar} from '@angular/material/snack-bar';
import {FormControl, Validators} from '@angular/forms';
import {finalize} from 'rxjs/operators';

@Component({
    standalone: false,
    selector: 'app-admin',
    templateUrl: './admin.component.html',
    styleUrls: ['./admin.component.css'],
})
export class AdminComponent implements OnInit {
    public activeView: 'accounts' | 'invitations' = 'accounts';
    public users: AdminUser[] = [];
    public invitations: Invitation[] = [];
    public invitationEmail = new FormControl('', {nonNullable: true, validators: [Validators.required, Validators.email]});
    public isLoading = true;
    public isCreatingInvitation = false;
    public createdCode = '';
    private reloadGeneration = 0;

    constructor(private admins: AdminService, private snack: MatSnackBar, private changeDetector: ChangeDetectorRef) {}

    public ngOnInit(): void {
        this.reload();
    }

    public selectView(view: 'accounts' | 'invitations'): void {
        this.activeView = view;
    }

    public reload(): void {
        const generation = ++this.reloadGeneration;
        this.isLoading = true;
        this.admins.users().pipe(finalize(() => {
            if (generation !== this.reloadGeneration) return;
            this.isLoading = false;
            this.changeDetector.markForCheck();
        })).subscribe({
            next: users => {
                if (generation !== this.reloadGeneration) return;
                this.users = users;
                this.changeDetector.markForCheck();
            },
            error: () => {
                if (generation === this.reloadGeneration) this.showError('Could not load accounts.');
            },
        });
        this.admins.invitations().subscribe({next: invitations => {
            if (generation !== this.reloadGeneration) return;
            this.invitations = invitations;
            this.changeDetector.markForCheck();
        }});
    }

    public activate(user: AdminUser): void {
        this.admins.activateUser(user.id).subscribe({
            next: () => { this.showMessage('Account activated.'); this.reload(); },
            error: () => this.showError('Could not activate this account.'),
        });
    }

    public block(user: AdminUser): void {
        this.admins.blockUser(user.id).subscribe({
            next: () => { this.showMessage('Account blocked.'); this.reload(); },
            error: () => this.showError('Could not block this account.'),
        });
    }

    public createInvitation(): void {
        if (this.invitationEmail.invalid) return;
        this.isCreatingInvitation = true;
        this.createdCode = '';
        this.admins.createInvitation(this.invitationEmail.value).pipe(finalize(() => this.isCreatingInvitation = false)).subscribe({
            next: result => {
                this.createdCode = result.code;
                this.invitationEmail.reset();
                this.invitations = [result.invitation, ...this.invitations.filter(invitation => invitation.id !== result.invitation.id)];
                this.changeDetector.markForCheck();
                this.reload();
            },
            error: () => this.showError('Could not create the invitation.'),
        });
    }

    public revoke(invitation: Invitation): void {
        this.admins.revokeInvitation(invitation.id).subscribe({
            next: () => { this.showMessage('Invitation expired.'); this.reload(); },
            error: () => this.showError('Could not revoke the invitation.'),
        });
    }

    public statusLabel(status: KYCStatus): string {
        return status === 1 ? 'Active' : status === 2 ? 'Pending' : 'Blocked';
    }

    public canActivate(user: AdminUser): boolean {
        return user.kyc_status === 2 || user.kyc_status === 3 || (user.kyc_status === 1 && !user.email_verified);
    }

    private showMessage(message: string): void { this.snack.open(message, 'Close', {duration: 5000}); }
    private showError(message: string): void { this.snack.open(message, 'Close', {duration: 10000}); }
}
