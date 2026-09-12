import { Component, type ErrorInfo, type ReactNode } from 'react'
import { logger } from '@/lib/logger'

interface Props {
  children: ReactNode
  /** 에러 발생 시 표시할 커스텀 fallback (기본: 내장 UI) */
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

/**
 * ErrorBoundary — React 컴포넌트 트리 에러 차단기
 *
 * 하위 컴포넌트에서 발생하는 예외를 포착하여 앱 전체 크래시를 방지합니다.
 * 에러 발생 시 fallback UI를 표시하고 재시도 버튼을 제공합니다.
 *
 * 사용법:
 *   <ErrorBoundary>
 *     <SomeCriticalComponent />
 *   </ErrorBoundary>
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logger.error('[ErrorBoundary] 컴포넌트 에러:', error, info.componentStack)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback

      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            padding: '2rem',
            gap: '1rem',
            color: 'var(--color-text-muted)',
            fontSize: '0.875rem',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '2rem' }}>⚠️</div>
          <div style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>
            렌더링 오류가 발생했습니다
          </div>
          {this.state.error && (
            <div
              style={{
                fontFamily: 'monospace',
                fontSize: '0.75rem',
                padding: '0.5rem 0.75rem',
                borderRadius: 2,
                background: 'var(--color-bg-surface)',
                border: '1px solid var(--color-border)',
                maxWidth: 400,
                wordBreak: 'break-word',
              }}
            >
              {this.state.error.message}
            </div>
          )}
          <button
            onClick={this.handleReset}
            style={{
              padding: '0.4rem 1rem',
              borderRadius: 2,
              border: '1px solid var(--color-border)',
              background: 'var(--color-bg-surface)',
              color: 'var(--color-text-primary)',
              cursor: 'pointer',
              fontSize: '0.75rem',
            }}
          >
            다시 시도
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
