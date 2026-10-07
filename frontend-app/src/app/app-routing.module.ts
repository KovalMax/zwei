import {RouterModule, Routes} from '@angular/router';
import {NgModule} from '@angular/core';
import {LoginComponent} from './login/login.component';
import {RegistrationComponent} from './registration/registration.component';
import {ProfileComponent} from './profile/profile.component';
import {AuthGuard} from './auth/auth.guard';
import {AuthResolver} from './auth/auth.resolver';
import {AdminGuard} from './auth/admin.guard';
import {PendingComponent} from './pending/pending.component';
import {ActivationComponent} from './activation/activation.component';
import {RootRedirectComponent} from './shared/root-redirect/root-redirect.component';

const routes: Routes = [
    {path: '', component: RootRedirectComponent, pathMatch: 'full'},
    {path: 'login', component: LoginComponent, resolve: [AuthResolver]},
    {path: 'sign-up', component: RegistrationComponent, resolve: [AuthResolver]},
    {path: 'home', canActivate: [AuthGuard], loadChildren: () => import('./home/home.module').then(module => module.HomeModule)},
    {path: 'profile', component: ProfileComponent, canActivate: [AuthGuard]},
    {path: 'pending', component: PendingComponent},
    {path: 'activate', component: ActivationComponent},
    {
        path: 'admin',
        canActivate: [AdminGuard],
        loadChildren: () => import('./admin/admin.module').then(module => module.AdminModule),
    },
];

@NgModule({
    imports: [RouterModule.forRoot(routes)],
    exports: [RouterModule],
})

export class AppRoutingModule {
}
