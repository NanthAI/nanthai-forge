// SPDX-License-Identifier: Apache-2.0
// The reference surface's figures (dev only, Item 6ebb58ab): one of each yardstick, chart, money block, access row,
// device and holder line and the yard from ds/figures.css, so the browser test checks them in both themes and at phone
// width. All figures are invented sample data.
import type { CSSProperties } from 'react';
import { Avatar, State, Who } from '../marks';
import { Region, Row } from '../parts';

/** Inline inputs for a figure (--v, --a, --b ...): numbers only, the CSS turns them into lengths. */
const vars = (inputs: Record<string, number>) =>
  Object.fromEntries(
    Object.entries(inputs).map(([key, value]) => [`--${key}`, String(value)]),
  ) as CSSProperties;

const DAYS = [6, 9, 4, 11, 8, 13, 7, 10, 12, 5, 9, 14];

export function Figures() {
  return (
    <>
      <Region title="Where things stand" weight="ref" fold="reference-yardsticks">
        <div className="pad" data-st="failed">
          <div className="stops" role="img" aria-label="Checking, one of six shards failed">
            <div className="on">
              Editing<small>3 saves</small>
            </div>
            <div className="on">
              Saved<small>14:20</small>
            </div>
            <div className="on">
              In queue<small>waited 2 min</small>
            </div>
            <div className="at">
              Checking<small>1 of 6 shards failed</small>
            </div>
            <div>main</div>
          </div>
        </div>
        <Row cols="auto minmax(0, 1fr) 160px auto">
          <span className="pos" data-st="conflict" role="img" aria-label="held at Saved">
            <i className="on" />
            <i className="at" />
            <i />
            <i />
            <i />
          </span>
          <span className="t2">held at Saved</span>
          <span className="stick" style={vars({ v: 72 })} role="img" aria-label="216 of 300 landings used">
            <i />
          </span>
          <span className="num t2">216 of 300</span>
        </Row>
        <Row cols="minmax(0, 14rem) minmax(0, 1fr) auto" data-st="active">
          <span className="ttl cut">Retry uploads after a dropped connection</span>
          <div className="trk" style={vars({ p: 3 })} role="img" aria-label="In the check">
            <span className="rl">
              <span className="fl" />
              <span className="nw">
                <span className="nd" />
              </span>
            </span>
          </div>
          <span className="shards" role="img" aria-label="4 shards passed, 1 running, 1 failed">
            <i className="ok" />
            <i className="ok" />
            <i className="ok" />
            <i className="ok" />
            <i className="run" />
            <i className="bad" />
          </span>
        </Row>
        <div className="ovl">
          <div className="oh">
            <State word="Conflict" />
            <span className="mono">src/upload/retry.ts</span>
            <span className="t2">40 lines</span>
          </div>
          <div className="ruler" style={vars({ rows: 2 })}>
            <div className="nm" style={vars({ i: 1 })}>
              <span className="ord">1</span>
              <Avatar handle="@sample-one/builder" />
              <span className="cut">sample-one</span>
            </div>
            <div className="rb" style={vars({ i: 1 })}>
              <i style={vars({ a: 20, b: 60 })} />
              <u style={vars({ a: 40, b: 60 })} />
            </div>
            <div className="nm" style={vars({ i: 2 })}>
              <span className="ord">2</span>
              <Avatar handle="@sample-two/builder" />
              <span className="cut">sample-two</span>
            </div>
            <div className="rb" style={vars({ i: 2 })}>
              <i style={vars({ a: 40, b: 85 })} />
              <u style={vars({ a: 40, b: 60 })} />
            </div>
            <div className="cross" style={vars({ rows: 2 })}>
              <u style={vars({ a: 40, b: 60 })} />
            </div>
            <div className="ax" style={vars({ rows: 2 })}>
              <span style={vars({ a: 0 })}>1</span>
              <span className="hot" style={vars({ a: 40 })}>
                17
              </span>
              <span style={vars({ a: 100 })}>40</span>
            </div>
          </div>
        </div>
        <div className="ends" data-st="passed" role="img" aria-label="Forge main and the mirror are level">
          <div className="end">
            <span>Forge main</span>
            <b>3 landings today</b>
          </div>
          <div className="gap" data-dir="out">
            <span>level, one way</span>
          </div>
          <div className="end">
            <span>Mirror main</span>
            <b className="mono">4f2a91c</b>
          </div>
        </div>
      </Region>

      <Region title="Figures" weight="ref" fold="reference-figures">
        <div className="fig">
          <h3>CI minutes for landing checks</h3>
          <div className="big">
            at least 420 fewer<small>up to 900 fewer</small>
          </div>
          <div
            className="vb"
            role="img"
            aria-label="Forge 380 minutes; replayed history 800 to 1,280 minutes; limit 1,500"
          >
            <div className="col">
              <span className="val">380</span>
              <i className="forge" style={vars({ h: 25 })} />
            </div>
            <div className="col">
              <span className="val">800 to 1,280</span>
              <i className="up" style={vars({ h: 32 })} />
              <i className="est" style={vars({ h: 53 })} />
            </div>
            <span className="lim" style={vars({ h: 100 })} />
          </div>
          <div className="vx">
            <span>Forge</span>
            <span>Replayed</span>
          </div>
        </div>
        <div className="fig">
          <h3>Landings per day</h3>
          <div className="vb tight" role="img" aria-label="Landings per day over 12 days, 4 to 14">
            {DAYS.map((n, index) => (
              <div key={index} className={index === DAYS.length - 1 ? 'col now' : 'col'}>
                <i className="ink" style={vars({ h: (n / 14) * 100 })} />
              </div>
            ))}
          </div>
        </div>
        <div className="legend">
          <span>
            <i className="forge" />
            Forge, measured
          </span>
          <span>
            <i className="est" />
            Replayed history, lower bound
          </span>
          <span>
            <i className="up" />
            up to the upper bound
          </span>
          <span className="sample">Sample data</span>
        </div>
        <div className="pad">
          <div
            className="pool"
            style={vars({ full: 500, used: 216, proj: 380, ticks: 25 })}
            role="img"
            aria-label="216 landings used of 300 included; about 380 at this pace; the limit is 500"
          >
            <i className="used" />
            <i className="est" />
            <i className="stop" style={vars({ at: 300 })} />
            <i className="stop end" />
          </div>
          <div className="poolx" style={vars({ full: 500 })}>
            <span style={vars({ at: 0 })}>
              <b>216</b>used
            </span>
            <span className="mid back" style={vars({ at: 300 })}>
              <b>300</b>included
            </span>
            <span className="endl">
              <b>500</b>limit
            </span>
          </div>
        </div>
        <div className="meter">
          <span className="k">
            CI minutes<small>this month</small>
          </span>
          <span
            className="rstick"
            style={vars({ v: 30, a: 30, b: 55, u: 70, lim: 90 })}
            role="img"
            aria-label="90 used, 165 to 210 expected, limit 270"
          >
            <i />
            <u />
            <s />
            <b />
          </span>
          <span className="v">
            165 to 210<small>limit 270</small>
          </span>
        </div>
        <dl className="lines">
          <dt>
            Pro, this month<small>1,000 landings included</small>
          </dt>
          <dd>$15.00</dd>
          <dt>
            1 extra block<small>500 landings</small>
          </dt>
          <dd>$10.00</dd>
          <dt className="sum">Next invoice</dt>
          <dd className="sum">$25.00</dd>
        </dl>
        <div className="nums">
          <div>
            <b>12</b>
            <span>landed</span>
          </div>
          <div>
            <b>3</b>
            <span>redone</span>
          </div>
          <div>
            <b>18 min</b>
            <span>thrown away</span>
          </div>
          <div>
            <b className="nr">not reported</b>
            <span>tokens</span>
          </div>
        </div>
        <div className="tally">
          <span>
            <b>2</b> of 5 read
          </span>
          <span>
            <b>1</b> note open
          </span>
          <span className="tag-rec">fits your pace</span>
        </div>
      </Region>

      <Region title="Access and holders" weight="ref" fold="reference-access">
        <div className="th acc" style={vars({ cols: 3 })}>
          <span>Who</span>
          <span>Read</span>
          <span>Land</span>
          <span>Admin</span>
          <span />
        </div>
        <div className="row acc" style={vars({ cols: 3 })}>
          <span className="nm">
            <Who handle="@sample-one" />
            <span className="sub">Owner</span>
          </span>
          {['Read', 'Land', 'Admin'].map(what => (
            <span key={what} className="c">
              <span className="k">{what}</span>
              <span className="yes" role="img" aria-label={`may ${what.toLowerCase()}`}>
                ✓
              </span>
            </span>
          ))}
          <span />
        </div>
        <div className="row acc in" style={vars({ cols: 3 })}>
          <span className="nm">
            <span className="who dev">
              <span className="av si" aria-hidden="true" />
              <span className="quoted">“desk machine”</span>
              <span className="dcode">dv-4k2m8p</span>
            </span>
            <span className="sgn">signed in for 30 days, renewed today</span>
          </span>
          {['Read', 'Land', 'Admin'].map(what => (
            <span key={what} className="c">
              <span className="k">{what}</span>
              {what === 'Admin' ? null : (
                <span className="yes" role="img" aria-label={`may ${what.toLowerCase()}`}>
                  ✓
                </span>
              )}
            </span>
          ))}
          <span />
        </div>
        <div className="holder">
          <span className="av ag lg" aria-hidden="true">
            sb
          </span>
          <div className="nm">
            <b>sample-builder</b> <span className="t2">acts for</span> <Who handle="@sample-one" />
            <span className="meta">an agent app · “desk machine” dv-4k2m8p · since 14:02</span>
          </div>
          <div className="btns">
            <State word="Working" />
          </div>
        </div>
        <div className="row hold">
          <span className="num">14:02</span>
          <span className="what">
            <span className="mono">sample-builder</span> took over from{' '}
            <span className="mono">sample-reviewer</span>
            <span className="why2">
              <span className="rsn">Takeover</span> · the first session was seen 50 s before
            </span>
          </span>
        </div>
      </Region>
    </>
  );
}
