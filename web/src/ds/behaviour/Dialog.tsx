// SPDX-License-Identifier: Apache-2.0
// The one overlay: a sheet over a scrim. Centred on a wide screen, from the bottom edge on a phone (core.css). Focus is
// held inside while open and returns to what opened it; Escape and a press on the scrim close it unless `required`.
import type { ReactNode } from 'react';
import { Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import { EnglishOnly } from './shared';

export type SheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  headerAction?: ReactNode;
  /** The answer keys, last one the main answer. */
  footer?: ReactNode;
  /** An answer is needed: Escape and the scrim do not close it (an alertdialog). */
  required?: boolean;
};

export function Sheet({ open, onOpenChange, title, children, footer, required, headerAction }: SheetProps) {
  return (
    <EnglishOnly>
      <ModalOverlay
        className="scrim"
        isOpen={open}
        onOpenChange={onOpenChange}
        isDismissable={!required}
        isKeyboardDismissDisabled={required}
      >
        <Modal className="sheet">
          <Dialog role={required ? 'alertdialog' : 'dialog'} className="ds-dialog">
            <div className={headerAction ? 'ph plain sheet-with-action' : 'ph plain'}>
              <Heading slot="title">{title}</Heading>
              {headerAction}
            </div>
            <div className="sbody">{children}</div>
            {footer ? <div className="sfoot">{footer}</div> : null}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </EnglishOnly>
  );
}
