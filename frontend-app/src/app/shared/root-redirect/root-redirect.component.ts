import {Component, OnInit} from '@angular/core';
import {Router} from '@angular/router';
import {AuthService} from '../../auth/auth.service';

@Component({
    standalone: false,
    selector: 'app-root-redirect',
    template: '<app-loading-spinner></app-loading-spinner>',
})
export class RootRedirectComponent implements OnInit {
    constructor(private auth: AuthService, private router: Router) {}

    public ngOnInit(): void {
        void this.router.navigate([this.auth.defaultAuthenticatedRoute()]);
    }
}
