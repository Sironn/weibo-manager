import { useEffect, useRef, useState, type KeyboardEvent } from "react";

type DateSegmentInputProps = {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
};

function splitDate(value: string): [string, string, string] {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? [match[1], match[2], match[3]] : ["", "", ""];
}

function daysInMonth(year: string, month: string): number {
  if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month)) {
    const monthNumber = Number(month);
    if (monthNumber === 2) return 29;
    if ([4, 6, 9, 11].includes(monthNumber)) return 30;
    return 31;
  }
  return new Date(Date.UTC(Number(year), Number(month) - 1 + 1, 0)).getUTCDate();
}

function isValidPartialMonth(value: string): boolean {
  if (value === "") return true;
  if (value.length === 1) return value === "0" || value === "1";
  const month = Number(value);
  return month >= 1 && month <= 12;
}

function isValidPartialDay(value: string, year: string, month: string): boolean {
  if (value === "") return true;
  if (value.length === 1) return /^[0-3]$/.test(value);
  const day = Number(value);
  return day >= 1 && day <= daysInMonth(year, month);
}

export default function DateSegmentInput({ value, onChange, ariaLabel }: DateSegmentInputProps) {
  const [year, setYear] = useState(() => splitDate(value)[0]);
  const [month, setMonth] = useState(() => splitDate(value)[1]);
  const [day, setDay] = useState(() => splitDate(value)[2]);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const lastSentValue = useRef(value);

  useEffect(() => {
    if (value === lastSentValue.current) return;
    lastSentValue.current = value;
    const parts = splitDate(value);
    setYear(parts[0]);
    setMonth(parts[1]);
    setDay(parts[2]);
  }, [value]);

  const update = (index: number, raw: string) => {
    const next = raw.replace(/\D/g, "").slice(0, index === 0 ? 4 : 2);
    const values = [year, month, day];
    if (index === 1 && !isValidPartialMonth(next)) return;
    if (index === 2 && !isValidPartialDay(next, year, month)) return;
    values[index] = next;

    if (index === 0 || index === 1) {
      const maxDay = daysInMonth(values[0], values[1]);
      if (values[2].length === 2 && Number(values[2]) > maxDay) values[2] = "";
    }

    setYear(values[0]);
    setMonth(values[1]);
    setDay(values[2]);

    const nextValue = values.every(part => part === "")
      ? ""
      : values[0].length === 4 && values[1].length === 2 && values[2].length === 2
        ? `${values[0]}-${values[1]}-${values[2]}`
        : "";
    lastSentValue.current = nextValue;
    onChange(nextValue);

    if (index === 0 && next.length === 4) inputs.current[1]?.focus();
    if (index === 1 && next.length === 2) inputs.current[2]?.focus();
  };

  const handleKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    const current = [year, month, day][index];
    if (event.key === "Backspace" && current === "" && index > 0) {
      inputs.current[index - 1]?.focus();
    }
    if (event.key === "ArrowLeft" && event.currentTarget.selectionStart === 0 && index > 0) {
      inputs.current[index - 1]?.focus();
    }
    if (event.key === "ArrowRight" && event.currentTarget.selectionStart === current.length && index < 2) {
      inputs.current[index + 1]?.focus();
    }
  };

  return (
    <div className="date-segments" role="group" aria-label={ariaLabel}>
      <label className="date-segment">
        <input ref={node => { inputs.current[0] = node; }} value={year} maxLength={4} inputMode="numeric" pattern="[0-9]*" placeholder="----" aria-label={`${ariaLabel}年份`} onChange={event => update(0, event.target.value)} onKeyDown={event => handleKeyDown(0, event)} />
        <span>年</span>
      </label>
      <label className="date-segment">
        <input ref={node => { inputs.current[1] = node; }} value={month} maxLength={2} inputMode="numeric" pattern="[0-9]*" placeholder="--" aria-label={`${ariaLabel}月份`} onChange={event => update(1, event.target.value)} onKeyDown={event => handleKeyDown(1, event)} />
        <span>月</span>
      </label>
      <label className="date-segment">
        <input ref={node => { inputs.current[2] = node; }} value={day} maxLength={2} inputMode="numeric" pattern="[0-9]*" placeholder="--" aria-label={`${ariaLabel}日期`} onChange={event => update(2, event.target.value)} onKeyDown={event => handleKeyDown(2, event)} />
        <span>日</span>
      </label>
    </div>
  );
}
