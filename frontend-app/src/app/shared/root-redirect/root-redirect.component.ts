import {Component, OnInit} from '@angular/core';
import {Router} from '@angular/router';
import {AuthService} from '../../auth/auth.service';

@Component({
    standalone: false,
    selector: 'app-root-redirect',
    template: '<div role="status" aria-live="polite" aria-atomic="true"><span class="visually-hidden">Restoring session</span><app-loading-spinner aria-hidden="true"></app-loading-spinner></div>',
    styles: [`
        :host { display: grid; height: 100%; place-items: center; --loading-spinner-color: var(--zwei-ink); }
        [role="status"] { line-height: 0; }
    `],
})
export class RootRedirectComponent implements OnInit {
    constructor(private auth: AuthService, private router: Router) {}

    public ngOnInit(): void {
        void this.router.navigate([this.auth.defaultAuthenticatedRoute()]);
    }
}
