`include "gen_defs.svh"

// Generic controller + datapath:
// - enum state register with a next-state case (FSM groundwork);
// - packed struct and packed-array-of-struct registers;
// - a function that reads module signals directly (operand select);
// - an alias chain inverse_i -> c_inv -> request_op -> instance port;
// - a submodule response loaded into partial-result registers;
// - spare_i is genuinely unused.
module gen_fsm_top import gen_pkg::*; (
  input  logic         clk,
  input  logic         rst_n,
  input  logic         start_i,
  input  logic         sel_i,
  input  logic [7:0]   a_i,
  input  logic [7:0]   b_i,
  input  logic         inverse_i,
  input  logic         spare_i,
  output logic [7:0]   y_o,
  output status_t      st_o,
  output state_e       state_o
);
  state_e       c_state, n_state;
  status_t      c_st;
  status_pair_t c_pair;
  logic         c_inv;
  logic [7:0]   request_op, response, c_part;

  function automatic logic [7:0] operand_for(input logic [1:0] op);
    if (op == 2'd0) operand_for = sel_i ? b_i : a_i;
    else operand_for = a_i;
  endfunction

  always_comb begin
    n_state = c_state;
    case (c_state)
      StIdle: if (start_i) n_state = StLoad;
      StLoad: n_state = StRun;
      StRun: n_state = StDone;
      default: n_state = StIdle;
    endcase
  end

  assign c_inv = inverse_i;
  assign request_op = c_inv ? operand_for(2'd0) : `GEN_RESET_VALUE;

  gen_worker u_worker (.op_i(request_op), .res_o(response));

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      c_state <= StIdle;
      c_part <= `GEN_RESET_VALUE;
      c_st <= '0;
      c_pair <= '0;
    end else begin
      c_state <= n_state;
      c_part <= response;
      c_st.busy <= start_i;
      c_pair[0] <= c_st;
    end
  end

  assign y_o = c_part;
  assign st_o = c_st;
  assign state_o = c_state;
endmodule
