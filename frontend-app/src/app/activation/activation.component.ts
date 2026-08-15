import {ChangeDetectorRef, Component, OnInit} from '@angular/core';
import {ActivatedRoute, Router} from '@angular/router';
import {AuthService} from '../auth/auth.service';
import {finalize} from 'rxjs/operators';

@Component({
    standalone: false,
    selector: 'app-activation',
    templateUrl: './activation.component.html',
    styleUrls: ['../auth/auth-surface.css', './activation.component.css'],
})
export class ActivationComponent implements OnInit {
    public isLoading = true;
    public activated = false;
    public error = false;

    constructor(private route: ActivatedRoute, private auth: AuthService, private router: Router, private changeDetector: ChangeDetectorRef) {}

    public ngOnInit(): void {
        const token = this.route.snapshot.queryParamMap.get('token');
        if (!token) {
            this.isLoading = false;
            this.error = true;
            return;
        }
        this.auth.activate(token).pipe(finalize(() => { this.isLoading = false; this.changeDetector.markForCheck(); })).subscribe({
            next: () => { this.activated = true; this.changeDetector.markForCheck(); },
            error: () => { this.error = true; this.changeDetector.markForCheck(); },
        });
    }

    public goToLogin(): void {
        void this.router.navigate(['/login']);
    }
}
