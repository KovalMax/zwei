import {Component} from '@angular/core';
import {PwaService} from './pwa/pwa.service';
import {PushClickService} from './pwa/push-click.service';

@Component({
    standalone: false,
    selector: 'app-root',
    templateUrl: './app.component.html',
    styleUrls: ['./app.component.css']
})
export class AppComponent {
    public constructor(public readonly pwa: PwaService, pushClicks: PushClickService) { pushClicks.start(); }
}
