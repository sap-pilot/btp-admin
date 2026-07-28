import { Component, lazy, Suspense, type ReactNode, type ErrorInfo } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router';

const Overview = lazy(() => import('@/pages/Overview'));
const History = lazy(() => import('@/pages/History'));

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
        <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-8">
          <div className="text-center space-y-3 max-w-md">
            <p className="text-destructive font-semibold">Something went wrong</p>
            <p className="text-sm text-muted-foreground break-words">{this.state.error.message}</p>
            <button
              onClick={() => this.setState({ error: null })}
              className="text-xs text-muted-foreground underline hover:text-foreground"
            >
              Try again
            </button>
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
            <Route path="/overview" element={<Overview />} />
            <Route path="/service/:name" element={<History />} />
            <Route path="/history/:name" element={<Navigate to="/overview" replace />} />
            <Route path="/" element={<Navigate to="/overview" replace />} />
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
