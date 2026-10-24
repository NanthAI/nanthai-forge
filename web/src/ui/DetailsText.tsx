// SPDX-License-Identifier: Apache-2.0
/** Display-only emphasis for the planning template's leading paragraph labels. */
export function DetailsText({ text }: { text: string }) {
  return (
    <>
      {text.split(/\r?\n[\t ]*\r?\n/).map((paragraph, index) => {
        const label = /^(Outcome\.|Why\.|Done when\.)(?=\s|$)/.exec(paragraph)?.[0];
        return (
          <p key={index}>
            {label ? (
              <>
                <strong>{label}</strong>
                {paragraph.slice(label.length)}
              </>
            ) : (
              paragraph
            )}
          </p>
        );
      })}
    </>
  );
}
