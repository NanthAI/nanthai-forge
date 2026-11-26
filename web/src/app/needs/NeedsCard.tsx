// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { Row } from '../../ds';

export function NeedsCard({
  status,
  actions,
  title,
  titleClass = '',
  next,
  className = '',
  children,
  ...props
}: Omit<ComponentPropsWithoutRef<'div'>, 'title'> & {
  status: ReactNode;
  actions?: ReactNode;
  title: ReactNode;
  titleClass?: string;
  next?: string | null;
}) {
  return (
    <Row {...props} cols="minmax(0, 1fr)" className={`needs-card ${className}`}>
      <div className="needs-card-top">
        <div className="needs-card-status">{status}</div>
        {actions ? <div className="needs-card-actions btns">{actions}</div> : null}
      </div>
      <h3 className={`ttl ${titleClass}`} dir="auto">
        {title}
      </h3>
      {children}
      {next ? (
        <p className="meta needs-card-next" dir="auto">
          Next: {next}
        </p>
      ) : null}
    </Row>
  );
}
