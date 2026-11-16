import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportError } from '../lib/observability/sentry';
import { CrashScreen } from './crash-screen';

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  crashed: boolean;
}

function reload(): void {
  window.location.reload();
}

/**
 * The last line of defence around the router: a render error the routes did not catch. It sits
 * outside the router, so "Back to your desk" is a plain link and "Try again" reloads the page.
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { crashed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { crashed: true };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    reportError(error, { where: 'react' });
  }

  render(): ReactNode {
    return this.state.crashed ? <CrashScreen onRetry={reload} /> : this.props.children;
  }
}
