import { Component, lazy, Suspense, type ReactNode, type ErrorInfo } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import AppLayout from '@/components/AppLayout';

const StatusOverview = lazy(() => import('@/pages/status/Overview'));
const StatusHistory = lazy(() => import('@/pages/status/History'));
const HomePage = lazy(() => import('@/pages/Home'));
const ConfigPage             = lazy(() => import('@/pages/ConfigPage'));
const DestinationOverview    = lazy(() => import('@/pages/destination/DestinationOverview'));
const RoleCollectionsOverview = lazy(() => import('@/pages/rcs/RoleCollectionsOverview'));
const UsersOverview           = lazy(() => import('@/pages/users/UsersOverview'));
const AppsPage                = lazy(() => import('@/pages/apps/AppsPage'));


interface EBState { error: Error | null }
class ErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  state: EBState = { error: null };

  static getDerivedStateFromError(error: Error): EBState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Render error:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full bg-background text-foreground items-center justify-center p-8">
          <div className="text-center space-y-3 max-w-md">
            <p className="text-destructive font-semibold">Something went wrong</p>
            <p className="text-sm text-muted-foreground break-words">{this.state.error.message}</p>
            <div className="flex flex-col items-center gap-1.5">
              <a
                href="/"
                className="text-xs text-muted-foreground underline hover:text-foreground"
              >
                Return to Home
              </a>
              <button
                onClick={() => history.back()}
                className="text-xs text-muted-foreground underline hover:text-foreground"
              >
                Return to previous screen
              </button>
              <button
                onClick={() => this.setState({ error: null })}
                className="text-xs text-muted-foreground underline hover:text-foreground"
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Suspense fallback={null}>
          <Routes>
            <Route element={<AppLayout />}>
              <Route path="/status" element={<StatusOverview />} />
              <Route path="/status/:name" element={<StatusHistory />} />
              <Route path="/home" element={<HomePage />} />
              <Route path="/home/:tab" element={<HomePage />} />
              <Route path="/apps" element={<Navigate to="/apps/all" replace />} />
              <Route path="/apps/:view" element={<AppsPage />} />
              <Route path="/destinations" element={<DestinationOverview />} />
              <Route path="/destinations/:tab" element={<DestinationOverview />} />
              <Route path="/destinations/:region/:subdomain/:spaceName/:instanceName/:instanceGuid/:name/:destTab" element={<DestinationOverview />} />
              <Route path="/destinations/:region/:subdomain/:spaceName/:instanceName/:instanceGuid/:name" element={<DestinationOverview />} />
              <Route path="/destinations/:region/:subdomain/:name/:destTab" element={<DestinationOverview />} />
              <Route path="/destinations/:region/:subdomain/:name" element={<DestinationOverview />} />
              <Route path="/role-collections" element={<RoleCollectionsOverview />} />
              <Route path="/role-collections/:tab" element={<RoleCollectionsOverview />} />
              <Route path="/role-collections/:region/:subdomain/:name/:rcTab" element={<RoleCollectionsOverview />} />
              <Route path="/role-collections/:region/:subdomain/:name" element={<RoleCollectionsOverview />} />
              <Route path="/users" element={<UsersOverview />} />
              <Route path="/users/:tab" element={<UsersOverview />} />
              <Route path="/users/:region/:subdomain" element={<UsersOverview />} />
              <Route path="/users/:region/:subdomain/:origin/:email" element={<UsersOverview />} />
              <Route path="/users/:region/:subdomain/:origin/:email/:userTab" element={<UsersOverview />} />
              <Route path="/config" element={<Navigate to="/config/orgs" replace />} />
              <Route path="/config/:tab" element={<ConfigPage />} />
              <Route path="/" element={<Navigate to="/home" replace />} />
              <Route path="*" element={<Navigate to="/home" replace />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
