import {BrowserModule} from '@angular/platform-browser';
import {NgModule} from '@angular/core';
import {AppRoutingModule} from './app-routing.module';
import {AppComponent} from './app.component';
import {BrowserAnimationsModule} from '@angular/platform-browser/animations';
import {AppMaterialModule} from './app-material.module';
import {FormsModule, ReactiveFormsModule} from '@angular/forms';
import {HeaderComponent} from './navigation/header/header.component';
import {LoginComponent} from './login/login.component';
import {RegistrationComponent} from './registration/registration.component';
import {HTTP_INTERCEPTORS, HttpClientModule} from '@angular/common/http';
import {AuthService} from './auth/auth.service';
import {AuthInterceptorService} from './auth/auth-interceptor.service';
import {RegistrationService} from './registration/registration.service';
import {ProfileComponent} from './profile/profile.component';
import {PendingComponent} from './pending/pending.component';
import {ActivationComponent} from './activation/activation.component';
import {RootRedirectComponent} from './shared/root-redirect/root-redirect.component';
import {ServiceWorkerModule} from '@angular/service-worker';
import {environment} from '../environments/environment';
import {SharedModule} from './shared/shared.module';

@NgModule({
    declarations: [
        AppComponent,
        HeaderComponent,
        LoginComponent,
        RegistrationComponent,
        ProfileComponent,
        PendingComponent,
        ActivationComponent,
        RootRedirectComponent,
    ],
    imports: [
        BrowserModule,
        BrowserAnimationsModule,
        AppRoutingModule,
        AppMaterialModule,
        FormsModule,
        ReactiveFormsModule,
        HttpClientModule,
        SharedModule,
        ServiceWorkerModule.register('ngsw-worker.js', {
            enabled: environment.production,
            registrationStrategy: 'registerWhenStable:30000',
        }),
    ],
    providers: [
        RegistrationService,
        {
            provide: HTTP_INTERCEPTORS,
            useClass: AuthInterceptorService,
            multi: true,
        }
    ],
    bootstrap: [AppComponent]
})
export class AppModule {
}
