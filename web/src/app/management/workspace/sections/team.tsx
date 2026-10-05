"use client";

import { useState } from "react";
import { Clock3, KeyRound, Plus } from "lucide-react";
import { api, errorMessage, type EmploymentStatus, type Role, type Staff } from "@/lib/api";
import { humanize, initials, optionLabel, text, timeLabel } from "../format";
import { Empty, Field, InlineError, Modal, useAction, useResource, type SectionProps } from "../ui";

/** Shows a one-time temporary password; it cannot be retrieved again. */
function PasswordReveal({ name, password, onClose }: { name: string; password: string; onClose: () => void }) {
  return (
    <Modal title="Temporary password" description={`Give this to ${name} privately. It is shown only once and must be changed at first sign-in.`} onClose={onClose}>
      <div className="secret-reveal">
        <code>{password}</code>
        <button type="button" className="button-secondary" onClick={() => void navigator.clipboard.writeText(password)}>
          Copy
        </button>
      </div>
    </Modal>
  );
}

export function TeamSection({ notify, refreshKey, can, reference, clockedIn, onClock }: SectionProps & { clockedIn: boolean | null; onClock: () => void }) {
  const staff = useResource(() => api.staff.list(), String(refreshKey));
  const [onboarding, setOnboarding] = useState(false);
  const [revealed, setRevealed] = useState<{ name: string; password: string } | null>(null);
  const action = useAction();
  const list = staff.data ?? [];

  const setStatus = async (member: Staff, status: EmploymentStatus) => {
    if (status !== "active" && !window.confirm(`Mark ${member.full_name} as ${optionLabel(reference.employmentStatuses, status).toLowerCase()}? They will be signed out everywhere.`)) return;
    try {
      await api.staff.updateStatus(member.id, status);
      notify(`${member.full_name} updated`);
      await staff.reload();
    } catch (error) {
      notify(errorMessage(error, "Staff update failed"));
    }
  };

  const resetPassword = async (member: Staff) => {
    if (!window.confirm(`Issue a new temporary password for ${member.full_name}? Their current sessions will end.`)) return;
    try {
      const { temporaryPassword } = await api.staff.resetPassword(member.id);
      setRevealed({ name: member.full_name, password: temporaryPassword });
    } catch (error) {
      notify(errorMessage(error, "Password reset failed"));
    }
  };

  return (
    <>
      <section className="panel bookings-panel full-panel">
        <div className="panel-heading bookings-heading">
          <div>
            <h2>Team & attendance</h2>
            <p>Staff accounts, roles and latest clock event.</p>
          </div>
          <div className="heading-actions">
            <span className="booking-count">{list.length} team members</span>
            {reference.assignableRoles.length > 0 && (
              <button className="button-primary" onClick={() => setOnboarding(true)}>
                <Plus size={16} /> Onboard staff
              </button>
            )}
          </div>
        </div>
        <InlineError message={staff.error} />
        {list.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>STAFF MEMBER</th>
                  <th>EMPLOYEE ID</th>
                  <th>DEPARTMENT</th>
                  <th>ROLE</th>
                  <th>LAST EVENT</th>
                  <th>EMPLOYMENT</th>
                  {can("staff:write") && <th>MANAGE</th>}
                </tr>
              </thead>
              <tbody>
                {list.map((member) => (
                  <tr key={member.id}>
                    <td>
                      <div className="guest-cell">
                        <span className="guest-avatar tone-blue">{initials(member.full_name)}</span>
                        <div>
                          <strong>{member.full_name}</strong>
                          <small>
                            {member.email} · {member.job_title}
                            {member.phone ? ` · ${member.phone}` : ""}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>{member.employee_number}</td>
                    <td>{member.department}</td>
                    <td>{optionLabel(reference.roles, member.role)}</td>
                    <td>
                      {member.last_attendance_event ? humanize(member.last_attendance_event) : "No clock event"}
                      {member.last_attendance_at ? ` · ${timeLabel(member.last_attendance_at)}` : ""}
                    </td>
                    <td>
                      <span className={`status ${member.employment_status === "active" ? "status-green" : "status-gold"}`}>
                        <i />
                        {optionLabel(reference.employmentStatuses, member.employment_status)}
                      </span>
                    </td>
                    {can("staff:write") && (
                      <td>
                        {member.can_manage ? (
                          <div className="reservation-actions">
                            <select className="inline-select" value={member.employment_status} onChange={(event) => void setStatus(member, event.target.value as EmploymentStatus)} aria-label={`Employment status for ${member.full_name}`}>
                              {reference.employmentStatuses.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                            <button className="icon-text-button" onClick={() => void resetPassword(member)} aria-label={`Reset password for ${member.full_name}`}>
                              <KeyRound size={14} />
                            </button>
                          </div>
                        ) : (
                          <span className="quiet-action">—</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !staff.loading && <Empty text="No staff have been onboarded yet." />
        )}
      </section>

      {clockedIn !== null && (
        <section className="panel operations-panel attendance-self">
          <div className="panel-heading">
            <div>
              <h2>Your attendance</h2>
              <p>{clockedIn ? "You are clocked in." : "You are clocked out."}</p>
            </div>
          </div>
          <button className="button-primary" onClick={onClock}>
            <Clock3 size={15} />
            {clockedIn ? "Clock out" : "Clock in"}
          </button>
        </section>
      )}

      {onboarding && (
        <Modal
          title="Onboard staff member"
          description="Leave the temporary password empty to generate a strong one. The account must change it at first sign-in."
          busy={action.busy}
          error={action.error}
          onClose={() => setOnboarding(false)}
          onSubmit={(values) =>
            action.run(async () => {
              const password = text(values.get("temporaryPassword"));
              const created = await api.staff.create({
                fullName: text(values.get("fullName")),
                email: text(values.get("email")),
                employeeNumber: text(values.get("employeeNumber")),
                department: text(values.get("department")),
                jobTitle: text(values.get("jobTitle")),
                role: text(values.get("role")) as Role,
                phone: text(values.get("phone")),
                emergencyContact: text(values.get("emergencyContact")),
                startDate: text(values.get("startDate")),
                ...(password ? { temporaryPassword: password } : {}),
              });
              setOnboarding(false);
              notify("Staff account created");
              if (created.temporaryPassword) setRevealed({ name: text(values.get("fullName")), password: created.temporaryPassword });
              await staff.reload();
            })
          }
        >
          <div className="form-row">
            <Field label="Full name">
              <input name="fullName" required maxLength={120} />
            </Field>
            <Field label="Work email">
              <input name="email" type="email" required maxLength={254} />
            </Field>
          </div>
          <div className="form-row">
            <Field label="Employee number">
              <input name="employeeNumber" required maxLength={40} />
            </Field>
            <Field label="Department">
              <input name="department" required maxLength={80} placeholder="Front desk" />
            </Field>
          </div>
          <div className="form-row">
            <Field label="Job title">
              <input name="jobTitle" required maxLength={80} />
            </Field>
            <Field label="Role">
              <select name="role" required>
                {reference.assignableRoles.map((role) => (
                  <option key={role.value} value={role.value}>
                    {role.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="form-row">
            <Field label="Phone">
              <input name="phone" type="tel" maxLength={32} />
            </Field>
            <Field label="Emergency contact">
              <input name="emergencyContact" maxLength={160} />
            </Field>
          </div>
          <div className="form-row">
            <Field label="Start date">
              <input name="startDate" type="date" />
            </Field>
            <Field label="Temporary password (optional, 12+ characters)">
              <input name="temporaryPassword" type="password" minLength={12} maxLength={256} autoComplete="new-password" />
            </Field>
          </div>
        </Modal>
      )}
      {revealed && <PasswordReveal name={revealed.name} password={revealed.password} onClose={() => setRevealed(null)} />}
    </>
  );
}
