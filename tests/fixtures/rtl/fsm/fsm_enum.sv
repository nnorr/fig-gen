// Enum-typed 3-state controller: if/else guards, a default recovery branch.
module fsm_enum (
    input  logic clk,
    input  logic rst_n,
    input  logic start_i,
    input  logic abort_i,
    input  logic done_i,
    output logic busy_o,
    output logic idle_o
);
  typedef enum logic [1:0] {
    StIdle,
    StWork,
    StFlush
  } st_e;

  st_e c_state;
  st_e n_state;

  always_comb begin
    n_state = c_state;
    unique case (c_state)
      StIdle: begin
        if (start_i) n_state = StWork;
      end
      StWork: begin
        if (abort_i) begin
          n_state = StIdle;
        end else if (done_i) begin
          n_state = StFlush;
        end
      end
      StFlush: n_state = StIdle;
      default: n_state = StFlush;
    endcase
  end

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) c_state <= StIdle;
    else c_state <= n_state;
  end

  assign busy_o = c_state == StWork;
  assign idle_o = c_state == StIdle;
endmodule
